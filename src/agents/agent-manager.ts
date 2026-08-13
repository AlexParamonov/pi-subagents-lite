/**
 * agent-manager.ts — Tracks agents, per-model concurrency, background execution.
 *
 * Supports per-model and per-provider concurrency limits with queuing.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { continueAgentSession, runAgent, type RunResult } from "./agent-runner.js";
import { AgentOutputLog } from "./output-file.js";
import { Watchdog } from "./watchdog.js";
import { getStore } from "../shell.js";
import {
  type AgentRecord,
  type AgentStatus,
  type RunCallbacks,
  type StopInitiator,
  type WatchdogStopDetail,
  type SpawnConfig,
} from "../types.js";
import type { SubagentType } from "./types.js";
import { getAgentConfig } from "./agent-types.js";
import { addUsage, getLifetimeTotal, getSessionContextPercent } from "./usage.js";
import { errorMessage, toSingleLine } from "../utils.js";
import { DEFAULT_GRACE_TURNS } from "../config/config-io.js";

export const WATCHDOG_TICK_MS = 5_000;

/** Milliseconds in one minute (config timeout thresholds are stored in minutes). */
const MINUTE_MS = 60_000;

/** Exact error message for queued agents that never start because the manager disposed (US-9). */
const DISPOSE_QUEUED_MESSAGE = "Agent manager disposed before the queued agent could start.";

/** UUID prefix length for agent IDs stored in the agents map (uniqueness). */
const AGENT_ID_PREFIX_LENGTH = 17;

const DEFAULT_CONCURRENCY_LIMIT = 4;

/** Whether the agent status is terminal (no longer running or queued). */
function isTerminalStatus(status: AgentStatus): boolean {
  return status !== "running" && status !== "queued";
}

function formatModelError(
  type: SubagentType,
  model: { provider: string; id: string } | undefined,
  providerError: string,
): string {
  const sanitizedError = toSingleLine(providerError);
  return model ? `${type} (${model.provider}/${model.id}): ${sanitizedError}` : `${type}: ${sanitizedError}`;
}

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

  private defaultConcurrency: number;

  private queue: { id: string; modelKey: string; args: SpawnArgs }[] = [];

  constructor(onComplete?: OnAgentComplete, concurrency?: ConcurrencyConfig, onStart?: OnAgentStart) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.defaultConcurrency = concurrency?.default ?? DEFAULT_CONCURRENCY_LIMIT;

    for (const [provider, limit] of Object.entries(concurrency?.providers ?? {})) {
      this.applyConcurrencyEntry(this.providerSlots, provider, limit);
    }

    for (const [modelKey, limit] of Object.entries(concurrency?.models ?? {})) {
      this.applyConcurrencyEntry(this.concurrencySlots, modelKey, limit);
    }

    this.watchdogInterval = setInterval(() => this.checkWatchdogs(), WATCHDOG_TICK_MS);
    this.watchdogInterval.unref();
  }

  /**
   * Update the concurrency configuration.
   * Existing slots are updated; new slots are created; slots whose keys are
   * absent from the new config are deleted so the new limit takes effect.
   * In-flight agents that held a reference to a deleted slot still decrement
   * that orphaned object in their .finally — a brief undercount window where
   * the running total is not reflected in any live slot. This is acceptable:
   * the agent completes shortly, and new spawns use the reconciled slots.
   * The queue is drained after update so newly expanded limits take effect.
   */
  setConcurrency(config: ConcurrencyConfig): void {
    this.defaultConcurrency = config.default;

    for (const [provider, limit] of Object.entries(config.providers ?? {})) {
      this.applyConcurrencyEntry(this.providerSlots, provider, limit);
    }

    for (const key of this.providerSlots.keys()) {
      if (!(config.providers ?? {})[key]) {
        this.providerSlots.delete(key);
      }
    }

    for (const [modelKey, limit] of Object.entries(config.models ?? {})) {
      this.applyConcurrencyEntry(this.concurrencySlots, modelKey, limit);
    }

    for (const key of this.concurrencySlots.keys()) {
      if (!(config.models ?? {})[key]) {
        this.concurrencySlots.delete(key);
      }
    }

    this.drainQueue();
  }

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
    let slot = this.concurrencySlots.get(modelKey);
    if (slot) return slot;

    const provider = modelKey.split("/")[0];
    const providerSlot = this.providerSlots.get(provider);
    if (providerSlot) return providerSlot;

    slot = { limit: Math.max(1, this.defaultConcurrency), running: 0 };
    this.concurrencySlots.set(modelKey, slot);
    return slot;
  }

  /** Spawn an agent, returning its ID immediately; queued when the concurrency limit is reached. */
  spawn(pi: ExtensionAPI, ctx: ExtensionContext, type: SubagentType, prompt: string, options: SpawnOptions): string {
    const id = randomUUID().slice(0, AGENT_ID_PREFIX_LENGTH);
    const abortController = new AbortController();
    const args: SpawnArgs = { pi, ctx, type, prompt, options };

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
        modelKey: options.modelKey,
        settled: false,
        settlementCount: 0,
      },
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        toolUses: 0,
        turnCount: 1,
        compactionCount: 0,
        maxTurns: options.maxTurns,
      },
    };
    // Capture the coordinator's live-view bridge so a continuation can re-wire
    // tool activity and streamed text into the widget's live view.
    record.execution.liveViewCallbacks = {
      onToolActivity: options.onToolActivity,
      onTextDelta: options.onTextDelta,
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
        // Never-started record: no run will settle it, so stopAgent opens the gate and notifies.
        this.stopAgent(record, "user");
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
      this.openGate(id, "");
      this.agents.delete(id);
      throw err;
    }
    return id;
  }

  /** Start an agent now or from queue drain; manages the slot's running count when one is held. */
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

    // Output transcript: agent frontmatter overrides the global setting (default false).
    const agentConfig = getAgentConfig(type);
    const outputTranscript = agentConfig?.outputTranscript ?? getStore().agent.outputTranscript;
    if (outputTranscript) {
      record.execution.outputLog = new AgentOutputLog(id, prompt, undefined, getStore().agent.outputThinkingBufferSize);
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
      ...this.runTrackingCallbacks(record, options, (turnCount) => {
        record.stats.turnCount = turnCount;
        options.onTurnEnd?.(turnCount);
      }),
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
        if (record.execution.outputLog) {
          record.execution.outputLog.attach(session);
        }
        options.onSessionCreated?.(session);
      },
    });
    this.attachSettlementChain(record, promise, concurrencySlot);
  }

  /**
   * Wire the shared settlement chain (status precedence, error formatting,
   * tally, slot release, gate open) onto a run promise. Used by both the
   * first run (startAgent) and continuations (continueSettledAgent) so the two paths
   * cannot drift. openGate is idempotent, so a continuation's second call
   * is a no-op — the gate resolver is dropped at the first settlement.
   */
  private attachSettlementChain(
    record: AgentRecord,
    runPromise: Promise<RunResult>,
    concurrencySlot?: ConcurrencySlot,
  ) {
    runPromise
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
        // A failed continuation must not leave the prior run's result visible.
        record.result = undefined;
        record.error = errorMessage(err);
        record.lifecycle.completedAt ??= Date.now();
        return "";
      })
      .finally(() => {
        // Count this settlement before notifying, so the completion callback
        // can tell a continuation settlement (>= 2) from the first one.
        record.execution.settlementCount++;
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

        if (concurrencySlot) concurrencySlot.running--;

        this.tallyCompletion(record);
        this.drainQueue();
        // Detach before opening the gate so an abort racing settlement cannot
        // re-target the record, and the coordinator's await resumes only after
        // the result text is captured and the completion notify has fired.
        this.detachParentBinding(record);
        this.openGate(record.id, record.result ?? "");
        // The run chain is fully settled: a continuation may now re-reserve
        // the slot and prompt the session again.
        record.execution.settled = true;
      });
  }

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

  private notifyComplete(record: AgentRecord): void {
    try {
      this.onComplete?.(record);
    } catch {
      /* ignore */
    }
  }

  private tallyCompletion(record: AgentRecord): void {
    // Usage is monotonic (addUsage only accumulates), so the delta from the
    // last tally is the cost this run added. The first tally (talliedCost
    // undefined) also counts the agent; continuations never double-count.
    const cost = record.stats.lifetimeUsage.cost;
    const baseline = record.execution.talliedCost ?? 0;
    this.totalAgentCost += cost - baseline;
    const firstTally = record.execution.talliedCost === undefined;
    record.execution.talliedCost = cost;
    if (firstTally) this.totalAgentCount++;
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
   * Callback set shared by a first run and a continuation: accumulates stats
   * on the record, feeds the watchdog, and forwards to the caller's own
   * callbacks. writeTurnCount is the per-path policy — the first run records
   * the absolute count, a continuation adds to the previous total.
   */
  private runTrackingCallbacks(
    record: AgentRecord,
    forward: RunCallbacks | undefined,
    writeTurnCount: (turnCount: number) => void,
  ): RunCallbacks {
    return {
      onToolActivity: (activity) => {
        if (activity.type === "end") record.stats.toolUses++;
        this.watchdog.recordActivity(record.id, activity);
        forward?.onToolActivity?.(activity);
      },
      onAssistantUsage: (usage) => {
        addUsage(record.stats.lifetimeUsage, usage);
        forward?.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.stats.compactionCount++;
        forward?.onCompaction?.(info);
      },
      onTextDelta: (delta: string, fullText: string) => {
        // Streamed response text counts as activity for the idle watchdog.
        this.watchdog.recordText(record.id);
        forward?.onTextDelta?.(delta, fullText);
      },
      onTurnEnd: writeTurnCount,
    };
  }

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
   * Steer a running agent; queues the message when the session isn't created
   * yet. A settled agent (completed, errored, aborted, stopped, turn-limited)
   * with a live session is continued: the concurrency slot is re-reserved,
   * the record is reset to running, and the session is prompted again.
   */
  async steer(id: string, message: string): Promise<boolean> {
    const record = this.agents.get(id);
    if (!record) return false;

    if (record.lifecycle.status === "running") {
      if (!record.execution.session) {
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
    return this.continueSettledAgent(record, message);
  }

  /**
   * Continue a settled agent: re-reserve the concurrency slot, reset the
   * record to running, and prompt the session again. Returns false when the
   * record cannot be continued (still settling, no session, streaming, or
   * the model's concurrency slot is full).
   */
  private continueSettledAgent(record: AgentRecord, message: string): boolean {
    // settled flips to true only after the previous run chain's .finally, so
    // a continuation cannot race the settlement cleanup (slot release, gate).
    if (!record.execution.settled) return false;
    const session = record.execution.session;
    if (!session) return false;
    // Defensive: a streaming session is mid-response and cannot be prompted.
    if (session.isStreaming) return false;

    // Re-reserve the concurrency slot (reject when full, don't queue). Skip
    // entirely when the spawn had no model key — the record never held a slot.
    let concurrencySlot: ConcurrencySlot | undefined;
    const modelKey = record.execution.modelKey;
    if (modelKey) {
      const slot = this.getSlot(modelKey);
      if (slot.running >= slot.limit) return false;
      concurrencySlot = slot;
      concurrencySlot.running++;
    }

    // Reset the record to running; stats (usage, toolUses, turnCount) carry over.
    const abortController = new AbortController();
    record.execution.abortController = abortController;
    record.execution.settled = false;
    record.lifecycle.status = "running";
    record.lifecycle.startedAt = Date.now();
    record.lifecycle.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;
    // A stale idle clock from the first run would kill the continuation
    // immediately — restart the watchdog before the new turn begins.
    this.watchdog.start(record.id);

    const previousTurns = record.stats.turnCount ?? 0;
    const promise = continueAgentSession(session, message, {
      ...this.runTrackingCallbacks(record, record.execution.liveViewCallbacks, (turnCount) => {
        record.stats.turnCount = previousTurns + turnCount;
      }),
      maxTurns: record.stats.maxTurns,
      graceTurns: getStore().agent.graceTurns ?? DEFAULT_GRACE_TURNS,
      signal: abortController.signal,
    });
    this.attachSettlementChain(record, promise, concurrencySlot);
    // The run proceeds asynchronously; the caller only learns the wiring
    // succeeded. The parent abort binding is deliberately NOT re-attached —
    // the parent turn that spawned the agent is over.
    return true;
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

  /** Abort the session or remove the agent from the queue. Returns false if not running/queued. */
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
    if (!record.lifecycle.started) {
      // A record that never started has no run whose .finally opens the
      // gate — open it now and notify directly. Such stops never tally as
      // completed agents.
      this.openGate(record.id, "");
      this.notifyComplete(record);
    }
    return true;
  }

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

  /** Stop agents violating tool/idle timeouts. Thresholds are read live so menu changes apply to running agents. */
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
