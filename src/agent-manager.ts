/**
 * agent-manager.ts — Tracks agents, per-model concurrency, background execution.
 *
 * Forked from upstream pi-subagents. Key modifications:
 *   - Per-model concurrency (Map<string, { limit, running }>) replaces
 *     single maxConcurrent counter
 *   - No worktree isolation (all worktree imports and code paths removed)
 *   - Exposes steer(id, message) for /steer command
 *   - SpawnOptions.modelKey for concurrency pool lookup
 *   - ConcurrencyConfig with default + models map
 *   - No IsolationMode references
 *   - AgentRecord: removed worktree, worktreeResult, groupId, joinMode
 */

import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import { createOutputFilePath, streamToOutputFile, writeInitialEntry } from "./output-file.js";
import type { AgentInvocation, AgentRecord, SubagentType, ThinkingLevel } from "./types.js";
import { addUsage, getLifetimeTotal } from "./usage.js";

/** Safely extract a human-readable error message from an unknown exception. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Create a cleanup function for the output file stream.
 * Captures final stats from the record at cleanup time so the DONE line
 * reflects actual turn count, tool uses, and total tokens.
 */
function createOutputCleanup(
  session: AgentSession,
  path: string,
  record: AgentRecord,
): () => void {
  const outputStats = { turnCount: 0, toolUseCount: 0, totalTokens: 0 };
  const cleanup = streamToOutputFile(session, path, outputStats);
  return () => {
    outputStats.turnCount = record.turnCount ?? 0;
    outputStats.toolUseCount = record.toolUses;
    outputStats.totalTokens = getLifetimeTotal(record.lifetimeUsage);
    cleanup();
  };
}

/** Whether the agent status is terminal (no longer running or queued). */
function isTerminalStatus(status: AgentRecord["status"]): boolean {
  return status !== "running" && status !== "queued";
}

/** Configuration for per-model concurrency limits. */
export interface ConcurrencyConfig {
  /** Default concurrency limit for models not in the models or providers map. */
  default: number;
  /** Per-provider concurrency limits keyed by provider name (e.g. "llamacpp"). */
  providers?: Record<string, number>;
  /** Per-model concurrency limits keyed by "provider/modelId". */
  models: Record<string, number>;
}

type OnAgentComplete = (record: AgentRecord) => void;
type OnAgentStart = (record: AgentRecord) => void;

/** Internal per-model concurrency state. */
interface ConcurrencySlot {
  limit: number;
  running: number;
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

export interface SpawnOptions {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  /**
   * Model key for concurrency pool lookup (e.g. "llamacpp/4b_small").
   * When set, the agent is counted against that model's concurrency limit.
   * When unset, the agent bypasses per-model concurrency limits.
   */
  modelKey?: string;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;

  /** Per-model concurrency slots keyed by "provider/modelId". */
  private concurrencySlots = new Map<string, ConcurrencySlot>();

  /** Per-provider concurrency slots — shared pool for all models from a provider. */
  private providerSlots = new Map<string, ConcurrencySlot>();

  /** Default concurrency limit for models not in the slots map. */
  private defaultConcurrency: number;

  /** Queue of agents waiting to start, keyed by modelKey. */
  private queue: { id: string; modelKey: string; args: SpawnArgs }[] = [];

  constructor(
    onComplete?: OnAgentComplete,
    concurrency?: ConcurrencyConfig,
    onStart?: OnAgentStart,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.defaultConcurrency = concurrency?.default ?? 4;

    // Initialize per-provider slots from config (shared pool)
    if (concurrency?.providers) {
      for (const [provider, limit] of Object.entries(concurrency.providers)) {
        this.providerSlots.set(provider, { limit: Math.max(1, limit), running: 0 });
      }
    }

    // Initialize per-model slots from config
    if (concurrency?.models) {
      for (const [modelKey, limit] of Object.entries(concurrency.models)) {
        this.concurrencySlots.set(modelKey, { limit: Math.max(1, limit), running: 0 });
      }
    }

    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  /**
   * Update the concurrency configuration.
   * Existing slots are updated; new slots are created; removed slots stay
   * (their running count will drain naturally). The queue is drained after
   * update so newly expanded limits take effect immediately.
   */
  setConcurrency(config: ConcurrencyConfig): void {
    this.defaultConcurrency = config.default;

    // Update per-provider slots (shared pool)
    if (config.providers) {
      for (const [provider, limit] of Object.entries(config.providers)) {
        const existing = this.providerSlots.get(provider);
        if (existing) {
          existing.limit = Math.max(1, limit);
        } else {
          this.providerSlots.set(provider, { limit: Math.max(1, limit), running: 0 });
        }
      }
    }

    // Update existing slots and create new ones
    for (const [modelKey, limit] of Object.entries(config.models)) {
      const existing = this.concurrencySlots.get(modelKey);
      if (existing) {
        existing.limit = Math.max(1, limit);
      } else {
        this.concurrencySlots.set(modelKey, { limit: Math.max(1, limit), running: 0 });
      }
    }

    // Start queued agents if the new limits allow
    this.drainQueue();
  }

  /**
   * Get or create a concurrency slot for a model key.
   * Precedence: per-model slot > per-provider shared slot > default (per-model).
   * Returns { slot, isProviderSlot } so caller knows which slot to decrement.
   */
  private getSlot(modelKey: string): { slot: ConcurrencySlot; isProviderSlot: boolean } {
    // 1. Check per-model slot
    let slot = this.concurrencySlots.get(modelKey);
    if (slot) return { slot, isProviderSlot: false };

    // 2. Check per-provider shared slot
    const provider = modelKey.split("/")[0];
    const providerSlot = this.providerSlots.get(provider);
    if (providerSlot) return { slot: providerSlot, isProviderSlot: true };

    // 3. Create per-model slot with default limit
    slot = { limit: Math.max(1, this.defaultConcurrency), running: 0 };
    this.concurrencySlots.set(modelKey, slot);
    return { slot, isProviderSlot: false };
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the per-model concurrency limit is reached, the agent is queued.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    // Check concurrency — applies to both foreground and background agents
    let queued = false;
    let concurrencySlot: ConcurrencySlot | undefined;
    if (options.modelKey) {
      const { slot } = this.getSlot(options.modelKey);
      if (slot.running >= slot.limit) {
        queued = true;
        this.queue.push({ id, modelKey: options.modelKey, args });
      } else {
        concurrencySlot = slot;
      }
    }

    const record: AgentRecord = {
      id,
      type,
      description: options.description,
      status: queued ? "queued" : "running",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      invocation: options.invocation,
      maxTurns: options.maxTurns,
    };
    this.agents.set(id, record);

    if (queued) return id;

    // startAgent can throw — clean up record so callers don't see an orphan
    try {
      this.startAgent(id, record, args, concurrencySlot);
    } catch (err) {
      this.agents.delete(id);
      throw err;
    }
    return id;
  }

  /**
   * Actually start an agent (called immediately or from queue drain).
   * When concurrencySlot is provided, the slot's running count is managed
   * (incremented on start, decremented in finally).
   */
  private startAgent(
    id: string,
    record: AgentRecord,
    { pi, ctx, type, prompt, options }: SpawnArgs,
    concurrencySlot?: ConcurrencySlot,
  ) {
    if (concurrencySlot) concurrencySlot.running++;

    record.status = "running";
    record.startedAt = Date.now();

    // Create output file for this agent
    record.outputFile = createOutputFilePath(id);
    writeInitialEntry(record.outputFile, prompt);

    this.onStart?.(record);

    // Wire parent abort signal to stop the subagent when the parent is interrupted
    if (options.signal) {
      options.signal.addEventListener("abort", () => this.abort(id), { once: true });
    }

    const promise = runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      thinkingLevel: options.thinkingLevel,
      signal: record.abortController!.signal,
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onTurnEnd: (turnCount) => {
        record.turnCount = turnCount;
        options.onTurnEnd?.(turnCount);
      },
      onTextDelta: options.onTextDelta,
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        options.onCompaction?.(info);
      },
      onSessionCreated: (session) => {
        record.session = session;
        // Flush any steers that arrived before the session was ready
        if (record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            session.steer(msg).catch(() => {});
          }
          record.pendingSteers = undefined;
        }
        // Stream session events to the output file
        if (record.outputFile) {
          record.outputCleanup = createOutputCleanup(
            session, record.outputFile, record,
          );
        }
        options.onSessionCreated?.(session);
      },
    })
      .then(({ responseText, session, aborted, steered }) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          record.status = aborted ? "aborted" : steered ? "steered" : "completed";
        }
        record.result = responseText;
        record.session = session;
        record.completedAt ??= Date.now();
        return responseText;
      })
      .catch((err) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          record.status = "error";
        }
        record.error = errorMessage(err);
        record.completedAt ??= Date.now();
        return "";
      })
      .finally(() => {
        // Final flush of streaming output file
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Decrement per-model concurrency count
        if (concurrencySlot) concurrencySlot.running--;

        try { this.onComplete?.(record); } catch { /* ignore */ }
        this.drainQueue();
      });

    record.promise = promise;
  }

  /** Start queued agents up to the per-model concurrency limits. */
  private drainQueue() {
    const started = new Set<string>();
    for (const entry of this.queue) {
      const record = this.agents.get(entry.id);
      if (!record || record.status !== "queued") continue;

      const slot = this.getSlot(entry.modelKey);
      if (slot.running >= slot.limit) continue;

      try {
        this.startAgent(entry.id, record, entry.args, slot);
        started.add(entry.id);
      } catch (err) {
        // Late failure — surface on the record so the user can see it
        record.status = "error";
        record.error = errorMessage(err);
        record.completedAt = Date.now();
        started.add(entry.id);
        this.onComplete?.(record);
      }
    }
    this.queue = this.queue.filter(e => !started.has(e.id));
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Respects per-model concurrency limits — queued if at capacity, awaited on completion.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
  ): Promise<AgentRecord> {
    const id = this.spawn(pi, ctx, type, prompt, { ...options, isBackground: false });
    const record = this.agents.get(id)!;
    await record.promise;
    return record;
  }

  /**
   * Resume an existing agent session with a new prompt.
   */
  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<AgentRecord | undefined> {
    const record = this.agents.get(id);
    if (!record?.session) return undefined;

    record.status = "running";
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;

    try {
      const responseText = await resumeAgent(record.session, prompt, {
        onToolActivity: (activity) => {
          if (activity.type === "end") record.toolUses++;
        },
        onAssistantUsage: (usage) => {
          addUsage(record.lifetimeUsage, usage);
        },
        onCompaction: (info) => {
          record.compactionCount++;
        },
        signal,
      });
      record.status = "completed";
      record.result = responseText;
      record.completedAt = Date.now();
    } catch (err) {
      record.status = "error";
      record.error = errorMessage(err);
      record.completedAt = Date.now();
    }

    return record;
  }

  /**
   * Send a steering message to a running agent.
   * If the session hasn't been created yet, the message is queued.
   */
  async steer(id: string, message: string): Promise<boolean> {
    const record = this.agents.get(id);
    if (!record) return false;

    if (record.status !== "running") return false;

    if (!record.session) {
      // Session not yet created — queue the steer
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
      return true;
    }

    try {
      await record.session.steer(message);
      return true;
    } catch {
      return false;
    }
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    return this.stopAgent(record);
  }

  /**
   * Stop an agent by aborting its session or removing it from the queue.
   * Returns true if the agent was stopped, false if it wasn't running/queued.
   */
  private stopAgent(record: AgentRecord): boolean {
    if (record.status === "queued") {
      this.queue = this.queue.filter(q => q.id !== record.id);
    } else if (record.status !== "running") {
      return false;
    } else {
      record.abortController?.abort();
    }
    record.status = "stopped";
    record.completedAt = Date.now();
    return true;
  }

  private disposeSession(session: AgentSession | undefined): void {
    session?.dispose();
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    this.disposeSession(record.session);
    record.session = undefined;
    this.agents.delete(id);
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (!isTerminalStatus(record.status)) continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
  }

  dispose() {
    clearInterval(this.cleanupInterval);
    this.queue = [];
    for (const record of this.agents.values()) {
      this.disposeSession(record.session);
    }
    this.agents.clear();
  }
}
