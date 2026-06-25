/**
 * agent-manager.ts — Tracks agents, per-model concurrency, background execution.
 *
 * Supports per-model and per-provider concurrency limits with queuing.
 */

import { randomUUID } from "node:crypto";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runAgent } from "./agent-runner.js";
import { AgentOutputLog } from "./output-file.js";
import { getStore } from "../shell.js";
import {
  type AgentRecord,
  type AgentStatus,
  type CompactionInfo,
  type RunCallbacks,
  SHORT_ID_LENGTH,
  type SpawnConfig,
  type ToolActivity,
} from "../types.js";
import type { SubagentType } from "./types.js";
import { addUsage, getLifetimeTotal, getSessionContextPercent, type AgentUsage } from "./usage.js";
import { errorMessage } from "../utils.js";

/** How often to check for expired agent records (milliseconds). */
const CLEANUP_INTERVAL_MS = 60_000;

/** Age after which a completed agent record is evicted (milliseconds). */
const CLEANUP_AGE_CUTOFF_MS = 10 * 60_000;

/** UUID prefix length for agent IDs stored in the agents map (uniqueness). */
const AGENT_ID_PREFIX_LENGTH = 17;



/** Default per-model concurrency limit when not specified in config. */
const DEFAULT_CONCURRENCY_LIMIT = 4;

/** Whether the agent status is terminal (no longer running or queued). */
function isTerminalStatus(status: AgentStatus): boolean {
  return status !== "running" && status !== "queued";
}

/** Configuration for per-model concurrency limits. */
export interface ConcurrencyConfig {
  /** Default concurrency limit for models not in the models or providers map. */
  default: number;
  /** Per-provider concurrency limits keyed by provider name (e.g. "llamacpp"). */
  providers?: Record<string, number>;
  /** Per-model concurrency limits keyed by "provider/modelId". */
  models?: Record<string, number>;
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

export interface SpawnOptions extends SpawnConfig, RunCallbacks {
  isBackground?: boolean;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;

  /** Session-level cumulative agent cost. Survives agent eviction. */
  private totalAgentCost = 0;

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
    private bufferSize: number = 0,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.defaultConcurrency = concurrency?.default ?? DEFAULT_CONCURRENCY_LIMIT;

    // Initialize per-provider slots from config (shared pool)
    for (const [provider, limit] of Object.entries(concurrency?.providers ?? {})) {
      this.applyConcurrencyEntry(this.providerSlots, provider, limit);
    }

    // Initialize per-model slots from config
    for (const [modelKey, limit] of Object.entries(concurrency?.models ?? {})) {
      this.applyConcurrencyEntry(this.concurrencySlots, modelKey, limit);
    }

    this.cleanupInterval = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
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
    for (const [provider, limit] of Object.entries(config.providers ?? {})) {
      this.applyConcurrencyEntry(this.providerSlots, provider, limit);
    }

    // Update existing slots and create new ones
    for (const [modelKey, limit] of Object.entries(config.models ?? {})) {
      this.applyConcurrencyEntry(this.concurrencySlots, modelKey, limit);
    }

    // Start queued agents if the new limits allow
    this.drainQueue();
  }

  /**
   * Update or create a concurrency slot entry.
   * If the key already exists in the map, updates its limit.
   * Otherwise, creates a new slot with the given limit and running=0.
   */
  private applyConcurrencyEntry(map: Map<string, ConcurrencySlot>, key: string, limit: number): void {
    const safeLimit = Math.max(1, limit);
    const existing = map.get(key);
    if (existing) {
      existing.limit = safeLimit;
    } else {
      map.set(key, { limit: safeLimit, running: 0 });
    }
  }

  /**
   * Get or create a concurrency slot for a model key.
   * Precedence: per-model slot > per-provider shared slot > default (per-model).
   */
  private getSlot(modelKey: string): ConcurrencySlot {
    // 1. Check per-model slot
    let slot = this.concurrencySlots.get(modelKey);
    if (slot) return slot;

    // 2. Check per-provider shared slot
    const provider = modelKey.split("/")[0];
    const providerSlot = this.providerSlots.get(provider);
    if (providerSlot) return providerSlot;

    // 3. Create per-model slot with default limit
    slot = { limit: Math.max(1, this.defaultConcurrency), running: 0 };
    this.concurrencySlots.set(modelKey, slot);
    return slot;
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
    const id = randomUUID().slice(0, AGENT_ID_PREFIX_LENGTH);
    const abortController = new AbortController();
    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    // Check concurrency — applies to both foreground and background agents
    let queued = false;
    let concurrencySlot: ConcurrencySlot | undefined;
    if (options.modelKey) {
      const slot = this.getSlot(options.modelKey);
      if (slot.running >= slot.limit) {
        queued = true;
        this.queue.push({ id, modelKey: options.modelKey, args });
      } else {
        concurrencySlot = slot;
      }
    }

    const record: AgentRecord = {
      id,
      lifecycle: {
        status: queued ? "queued" : "running",
        startedAt: Date.now(),
      },
      display: {
        type,
        description: options.description,
        invocation: options.invocation,
        worktreePath: options.worktreePath,
        worktreeLabel: options.worktreeLabel,
      },
      execution: {
        abortController,
      },
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        toolUses: 0,
        turnCount: 1,
        compactionCount: 0,
        maxTurns: options.maxTurns,
      },
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

    record.lifecycle.status = "running";
    record.lifecycle.startedAt = Date.now();

    // Create output log for this agent (creates file + writes [USER] entry)
    record.execution.outputLog = new AgentOutputLog(id, prompt, undefined, this.bufferSize);
    record.display.outputFile = record.execution.outputLog.path;

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
      maxTokens: options.maxTokens,
      thinkingLevel: options.thinkingLevel,
      cwd: options.worktreePath,
      graceTurns: options.graceTurns,
      signal: record.execution.abortController!.signal,
      ...this.createRecordCallbacks(record, options),
      onTurnEnd: (turnCount) => {
        record.stats.turnCount = turnCount;
        options.onTurnEnd?.(turnCount);
      },
      onTextDelta: options.onTextDelta,
      onSessionCreated: (session) => {
        record.execution.session = session;
        // Flush any steers that arrived before the session was ready
        if (record.execution.pendingSteers?.length) {
          for (const msg of record.execution.pendingSteers) {
            session.steer(msg).catch(() => {
              // Steer is advisory — a failure here (e.g. session already aborting)
              // is fine; the user can re-send if needed.
            });
          }
          record.execution.pendingSteers = undefined;
        }
        // Attach output log stream to session
        if (record.execution.outputLog) {
          record.execution.outputLog.attach(session);
        }
        options.onSessionCreated?.(session);
      },
    })
      .then(({ responseText, session, aborted, turnLimited }) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.lifecycle.status !== "stopped") {
          record.lifecycle.status = aborted ? "aborted" : turnLimited ? "turn_limited" : "completed";
        }
        record.result = responseText;
        record.execution.session = session;
        record.stats.contextPercent = getSessionContextPercent(session);
        record.lifecycle.completedAt ??= Date.now();
        return responseText;
      })
      .catch((err) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.lifecycle.status !== "stopped") {
          record.lifecycle.status = "error";
        }
        record.error = errorMessage(err);
        record.lifecycle.completedAt ??= Date.now();
        return "";
      })
      .finally(() => {
        // Finalize output log with final stats
        if (record.execution.outputLog) {
          try {
            record.execution.outputLog.finalize({
              turnCount: record.stats.turnCount ?? 0,
              toolUseCount: record.stats.toolUses,
              totalTokens: getLifetimeTotal(record.stats.lifetimeUsage),
              cost: record.stats.lifetimeUsage.cost,
            });
          } catch { /* ignore */ }
          record.execution.outputLog = undefined;
        }

        // Decrement per-model concurrency count
        if (concurrencySlot) concurrencySlot.running--;

        this.safeNotifyComplete(record);
        this.drainQueue();
      });

    record.execution.promise = promise;
  }

  /** Notify completion callback, ignoring any errors. */
  private safeNotifyComplete(record: AgentRecord): void {
    this.totalAgentCost += record.stats.lifetimeUsage.cost;
    try { this.onComplete?.(record); } catch { /* ignore */ }
  }

  setOnComplete(cb: OnAgentComplete): void {
    this.onComplete = cb;
  }

  /** Get the session-level cumulative agent cost. Survives agent eviction. */
  getTotalAgentCost(): number {
    return this.totalAgentCost;
  }

  /**
   * Build common record-tracking callbacks shared by startAgent.
   * Updates the record's toolUses, lifetimeUsage, and compactionCount.
   * When options are provided, also forwards events to the caller.
   */
  private createRecordCallbacks(
    record: AgentRecord,
    options?: Pick<SpawnOptions, "onToolActivity" | "onAssistantUsage" | "onCompaction">,
  ): {
    onToolActivity: (activity: ToolActivity) => void;
    onAssistantUsage: (usage: AgentUsage) => void;
    onCompaction: (info: CompactionInfo) => void;
  } {
    return {
      onToolActivity: (activity) => {
        if (activity.type === "end") record.stats.toolUses++;
        options?.onToolActivity?.(activity);
      },
      onAssistantUsage: (usage) => {
        // vLLM doesn't report cache hits, so usage.input is full prompt_tokens.
        // Estimate new tokens as delta from previous message's input.
        const deltaEnabled = getStore().agent.deltaInputTokens;
        const cacheRead = usage.cacheRead;
        let inputDelta = usage.input;
        if (deltaEnabled && cacheRead === 0 && record.stats.prevInputTokens != null && usage.input > record.stats.prevInputTokens) {
          inputDelta = usage.input - record.stats.prevInputTokens;
        }
        record.stats.prevInputTokens = usage.input;

        addUsage(record.stats.lifetimeUsage, { ...usage, input: inputDelta });
        options?.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.stats.compactionCount++;
        options?.onCompaction?.(info);
      },
    };
  }

  /** Start queued agents up to the per-model concurrency limits. */
  private drainQueue() {
    const started = new Set<string>();
    for (const entry of this.queue) {
      const record = this.agents.get(entry.id);
      if (!record || record.lifecycle.status !== "queued") continue;

      const slot = this.getSlot(entry.modelKey);
      if (slot.running >= slot.limit) continue;

      try {
        this.startAgent(entry.id, record, entry.args, slot);
        started.add(entry.id);
      } catch (err) {
        // Late failure — surface on the record so the user can see it
        record.lifecycle.status = "error";
        record.error = errorMessage(err);
        record.lifecycle.completedAt = Date.now();
        started.add(entry.id);
        this.safeNotifyComplete(record);
      }
    }
    this.queue = this.queue.filter(e => !started.has(e.id));
  }


  /**
   * Send a steering message to a running agent.
   * If the session hasn't been created yet, the message is queued.
   */
  async steer(id: string, message: string): Promise<boolean> {
    const record = this.agents.get(id);
    if (!record) return false;

    if (record.lifecycle.status !== "running") return false;

    if (!record.execution.session) {
      // Session not yet created — queue the steer
      if (!record.execution.pendingSteers) record.execution.pendingSteers = [];
      record.execution.pendingSteers.push(message);
      return true;
    }

    try {
      await record.execution.session.steer(message);
      return true;
    } catch {
      // steer failures are surfaced to the caller via the boolean return value
      return false;
    }
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.lifecycle.startedAt - a.lifecycle.startedAt,
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
    if (record.lifecycle.status === "queued") {
      this.queue = this.queue.filter(q => q.id !== record.id);
    } else if (record.lifecycle.status !== "running") {
      return false;
    } else {
      record.execution.abortController?.abort();
    }
    record.lifecycle.status = "stopped";
    record.lifecycle.completedAt = Date.now();
    return true;
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    record.execution.session?.dispose();
    record.execution.session = undefined;
    this.agents.delete(id);
  }

  private cleanup() {
    const cutoff = Date.now() - CLEANUP_AGE_CUTOFF_MS;
    for (const [id, record] of this.agents) {
      if (!isTerminalStatus(record.lifecycle.status)) continue;
      if ((record.lifecycle.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
  }

  dispose() {
    clearInterval(this.cleanupInterval);
    this.queue = [];
    for (const record of this.agents.values()) {
      record.execution.session?.dispose();
    }
    this.agents.clear();
  }
}
