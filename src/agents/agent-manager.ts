/**
 * agent-manager.ts — Tracks agents, per-model concurrency, background execution.
 *
 * Supports per-model and per-provider concurrency limits with queuing.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runAgent } from "./agent-runner.js";
import { AgentOutputLog } from "./output-file.js";
import { Watchdog } from "./watchdog.js";
import { getStore } from "../shell.js";
import {
  type AgentRecord,
  type AgentStatus,
  type CompactionInfo,
  type RunCallbacks,
  type StopInitiator,
  type WatchdogStopDetail,
  type SpawnConfig,
  type ToolActivity,
} from "../types.js";
import type { SubagentType } from "./types.js";
import { getAgentConfig } from "./agent-types.js";
import { addUsage, getLifetimeTotal, getSessionContextPercent, type AgentUsage } from "./usage.js";
import { errorMessage, toSingleLine } from "../utils.js";

/** How often the watchdog scans running agents for stuck state (milliseconds). */
export const WATCHDOG_TICK_MS = 5_000;

/** Milliseconds in one minute (config timeout thresholds are stored in minutes). */
const MINUTE_MS = 60_000;

/** Exact error message for queued agents that never start because the manager disposed (US-9). */
const DISPOSE_QUEUED_MESSAGE = "Agent manager disposed before the queued agent could start.";

/** UUID prefix length for agent IDs stored in the agents map (uniqueness). */
const AGENT_ID_PREFIX_LENGTH = 17;

/** Default per-model concurrency limit when not specified in config. */
const DEFAULT_CONCURRENCY_LIMIT = 4;

/** Whether the agent status is terminal (no longer running or queued). */
function isTerminalStatus(status: AgentStatus): boolean {
  return status !== "running" && status !== "queued";
}

/**
 * Format the model error recorded on a failed run: the subagent type, the
 * resolved model (provider/id), and the provider's error message.
 */
function formatModelError(
  type: SubagentType,
  model: { provider: string; id: string } | undefined,
  providerError: string,
): string {
  const sanitizedError = toSingleLine(providerError);
  return model ? `${type} (${model.provider}/${model.id}): ${sanitizedError}` : `${type}: ${sanitizedError}`;
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
  /** Time-based stuck-agent detection state (tool + idle timeouts). */
  private watchdog = new Watchdog();
  private watchdogInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;

  /** Completion-gate resolvers for every spawned record, keyed by agent id. The gate
   * (record.execution.promise) is created at spawn and opened exactly once at the record's
   * terminal transition; the resolver is dropped when the gate opens. Never assigned the
   * run's own promise (gate invariant). */
  private gateResolvers = new Map<string, (value: string) => void>();

  /** Parent-interrupt bindings by record, removed at every terminal transition. */
  private parentBindings = new WeakMap<AgentRecord, { signal: AbortSignal; handler: () => void }>();

  /** Session-level cumulative agent cost. Survives record removal (Clear/dispose). */
  private totalAgentCost = 0;

  /** Session-level completed agent count. Survives record removal (Clear/dispose). */
  private totalAgentCount = 0;

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

    this.watchdogInterval = setInterval(() => this.checkWatchdogs(), WATCHDOG_TICK_MS);
    this.watchdogInterval.unref();
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
  spawn(pi: ExtensionAPI, ctx: ExtensionContext, type: SubagentType, prompt: string, options: SpawnOptions): string {
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
        // Flipped synchronously in startAgent; distinguishes never-started stops.
        started: false,
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

    // Completion gate: every record carries one from birth, opened exactly once
    // at its terminal transition (settlement, queued stop, start failure,
    // already-aborted spawn, dispose, removal).
    record.execution.promise = this.createCompletionGate(id);

    // Parent interrupt binding: registered before the queued early-return so
    // queued subagents are covered too. An already-aborted signal never starts
    // the subagent — it is recorded as stopped immediately instead (ADR-0005).
    if (options.signal) {
      if (options.signal.aborted) {
        if (queued) {
          this.queue = this.queue.filter((q) => q.id !== id);
        }
        record.lifecycle.status = "stopped";
        record.lifecycle.stoppedBy = "user";
        record.lifecycle.completedAt = Date.now();
        this.openGate(id, "");
        this.notifyComplete(record);
        return id;
      }
      const handler = () => this.abort(id, "user");
      options.signal.addEventListener("abort", handler, { once: true });
      this.parentBindings.set(record, { signal: options.signal, handler });
    }

    if (queued) return id;

    // startAgent can throw — clean up record so callers don't see an orphan
    try {
      this.startAgent(id, record, args, concurrencySlot);
    } catch (err) {
      this.detachParentBinding(record);
      this.gateResolvers.delete(id);
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
    // Set synchronously before the run so a stop before the session exists
    // still renders as ran-then-stopped, not never-started.
    record.lifecycle.started = true;
    // The idle clock starts here, so a hung pre-session init phase is covered.
    this.watchdog.start(id);

    // Create output log for this agent (creates file + writes [USER] entry)
    // Gate on outputTranscript setting: agent frontmatter overrides global config, default true
    const agentConfig = getAgentConfig(type);
    const outputTranscript = agentConfig?.outputTranscript ?? getStore().agent.outputTranscript;
    if (outputTranscript) {
      record.execution.outputLog = new AgentOutputLog(id, prompt, undefined, this.bufferSize);
      record.display.outputFile = record.execution.outputLog.path;
    }

    this.onStart?.(record);

    const promise = runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      model: options.model,
      maxTurns: options.maxTurns,
      maxTokens: options.maxTokens,
      thinkingLevel: options.thinkingLevel,
      cwd: options.worktreePath,
      graceTurns: options.graceTurns,
      projectTrusted: options.projectTrusted,
      signal: record.execution.abortController!.signal,
      ...this.createRecordCallbacks(record, options),
      onTurnEnd: (turnCount) => {
        record.stats.turnCount = turnCount;
        options.onTurnEnd?.(turnCount);
      },
      onTextDelta: (delta, fullText) => {
        // Streamed response text counts as activity for the idle watchdog.
        this.watchdog.recordText(id);
        options.onTextDelta?.(delta, fullText);
      },
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
      .then(({ responseText, session, aborted, turnLimited, modelError }) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.lifecycle.status !== "stopped") {
          // Precedence: an abort during a model error wins; a model error outranks a turn limit.
          record.lifecycle.status = aborted
            ? "aborted"
            : modelError
              ? "error"
              : turnLimited
                ? "turn_limited"
                : "completed";
        }
        record.result = responseText;
        if (modelError) {
          record.error = formatModelError(record.display.type, session?.model, modelError);
        }
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
            });
          } catch {
            /* ignore */
          }
          record.execution.outputLog = undefined;
        }

        // Decrement per-model concurrency count
        if (concurrencySlot) concurrencySlot.running--;

        this.tallyCompletion(record);
        this.drainQueue();
        // Detach before opening the gate so an abort racing settlement cannot
        // re-target the record, and the coordinator's await resumes only after
        // the result text is captured and the completion notify has fired.
        this.detachParentBinding(record);
        this.openGate(record.id, record.result ?? "");
      });
  }

  /** Create a record's completion gate and store its resolver for the terminal transition. */
  private createCompletionGate(id: string): Promise<string> {
    let resolve!: (value: string) => void;
    const gate = new Promise<string>((res) => {
      resolve = res;
    });
    this.gateResolvers.set(id, resolve);
    return gate;
  }

  /** Open a record's completion gate. Idempotent — the resolver is dropped on first open. */
  private openGate(id: string, value: string): void {
    const resolve = this.gateResolvers.get(id);
    if (!resolve) return;
    this.gateResolvers.delete(id);
    resolve(value);
  }

  /** Remove a record's parent-interrupt binding; a later abort of the signal is a no-op. */
  private detachParentBinding(record: AgentRecord): void {
    const binding = this.parentBindings.get(record);
    if (!binding) return;
    this.parentBindings.delete(record);
    binding.signal.removeEventListener("abort", binding.handler);
  }

  /** Fire the onComplete callback, ignoring any errors from the callback itself. */
  private notifyComplete(record: AgentRecord): void {
    try {
      this.onComplete?.(record);
    } catch {
      /* ignore */
    }
  }

  /** Tally session cost/count for a completed agent, then notify. */
  private tallyCompletion(record: AgentRecord): void {
    this.totalAgentCost += record.stats.lifetimeUsage.cost;
    this.totalAgentCount++;
    this.notifyComplete(record);
  }

  setOnComplete(cb: OnAgentComplete): void {
    this.onComplete = cb;
  }

  /** Get the session-level cumulative agent cost. Survives record removal (Clear/dispose). */
  getTotalAgentCost(): number {
    return this.totalAgentCost;
  }

  /** Get the session-level completed agent count. Survives record removal (Clear/dispose). */
  getTotalAgentCount(): number {
    return this.totalAgentCount;
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
        this.watchdog.recordActivity(record.id, activity);
        options?.onToolActivity?.(activity);
      },
      onAssistantUsage: (usage) => {
        // vLLM doesn't report cache hits, so usage.input is full prompt_tokens.
        // Estimate new tokens as delta from previous message's input.
        const deltaEnabled = getStore().agent.deltaInputTokens;
        const cacheRead = usage.cacheRead;
        let inputDelta = usage.input;
        if (
          deltaEnabled &&
          cacheRead === 0 &&
          record.stats.prevInputTokens != null &&
          usage.input > record.stats.prevInputTokens
        ) {
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
        this.detachParentBinding(record);
        this.openGate(record.id, "");
        started.add(entry.id);
        // Failed starts notify the UI but aren't tallied as completed agents
        this.notifyComplete(record);
      }
    }
    this.queue = this.queue.filter((e) => !started.has(e.id));
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
    return [...this.agents.values()].sort((a, b) => b.lifecycle.startedAt - a.lifecycle.startedAt);
  }

  /**
   * Remove a terminal record: dispose its session and detach any parent
   * interrupt binding (ADR-0006). Running/queued records are rejected — Stop is
   * the action there. Clear is the only per-record removal besides dispose().
   */
  clear(id: string): boolean {
    const record = this.agents.get(id);
    if (!record || !isTerminalStatus(record.lifecycle.status)) return false;
    this.removeRecord(id, record);
    return true;
  }

  abort(id: string, stoppedBy?: StopInitiator, stopDetail?: WatchdogStopDetail): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    return this.stopAgent(record, stoppedBy, stopDetail);
  }

  /**
   * Stop an agent by aborting its session or removing it from the queue.
   * Returns true if the agent was stopped, false if it wasn't running/queued.
   */
  private stopAgent(record: AgentRecord, stoppedBy?: StopInitiator, stopDetail?: WatchdogStopDetail): boolean {
    const wasQueued = record.lifecycle.status === "queued";
    if (wasQueued) {
      this.queue = this.queue.filter((q) => q.id !== record.id);
    } else if (record.lifecycle.status !== "running") {
      return false;
    } else {
      record.execution.abortController?.abort();
    }
    record.lifecycle.status = "stopped";
    record.lifecycle.stoppedBy = stoppedBy;
    record.lifecycle.stopDetail = stopDetail;
    record.lifecycle.completedAt = Date.now();
    this.detachParentBinding(record);
    if (wasQueued) {
      // A queued record has no run to settle — open the gate and notify now.
      // Queued stops notify directly; they never tally as completed agents.
      this.openGate(record.id, "");
      this.notifyComplete(record);
    }
    return true;
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    record.execution.session?.dispose();
    record.execution.session = undefined;
    this.detachParentBinding(record);
    // A stopped record's run can still be settling (stopAgent flips status
    // synchronously; the gate opens in .finally) — resolve so the coordinator's
    // await never dangles, then drop the resolver. A later .finally resolve no-ops.
    this.openGate(id, "");
    this.agents.delete(id);
  }

  /**
   * Scan running agents for tool-timeout and idle-timeout violations and stop
   * the offenders with a watchdog reason. Thresholds are read live from the
   * config store, so menu changes apply to running agents immediately.
   */
  private checkWatchdogs(): void {
    const { toolTimeoutMinutes, idleTimeoutMinutes } = getStore().agent;
    const decisions = this.watchdog.check(
      toolTimeoutMinutes * MINUTE_MS,
      idleTimeoutMinutes * MINUTE_MS,
      (id) => this.agents.get(id)?.lifecycle.status === "running",
    );
    for (const [id, detail] of decisions) {
      this.abort(id, "watchdog", detail);
    }
  }

  dispose() {
    clearInterval(this.watchdogInterval);
    this.queue = [];
    for (const record of this.agents.values()) {
      // Queued subagents never start: fail them honestly so the waiting tool
      // call resumes with an explicit error instead of hanging (US-9).
      if (record.lifecycle.status === "queued") {
        record.lifecycle.status = "error";
        record.error = DISPOSE_QUEUED_MESSAGE;
        record.lifecycle.completedAt = Date.now();
        this.openGate(record.id, "");
      }
      record.execution.session?.dispose();
      this.detachParentBinding(record);
    }
    // Running records' gates open when their runs settle after this synchronous
    // pass — keep their resolvers so .finally can still resolve (no dangling gate).
    this.agents.clear();
  }
}
