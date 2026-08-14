/**
 * config-store.ts — Deep module owning persisted config + per-session overrides.
 *
 * Absorbs config-io.ts, config-mutator.ts, and the config/widget-sync half of
 * state.ts. See docs/adr/0004-composition-root-over-shared-state.md.
 *
 * - Reads return defaults baked in (no `?? 6` at call sites).
 * - Each persisted mutate method is mutate + persist + its side effect, so a
 *   side effect cannot be forgotten.
 * - Widget/manager are injected after construction (they're created lazily).
 * - Effective config resolves session overrides → project file → global file
 *   → built-in defaults (ADR-0008). Mutations target one layer; each file
 *   stores only its own keys and the merged config is never written back.
 *
 * Lifecycle: per-session. `reload()` re-reads disk + resets session overrides
 * at session_start. `dispose()` drops deps at session_shutdown.
 */

import type { SubagentsConfig, SessionModelOverrides } from "../models/model-precedence.js";
import { resolveModel } from "../models/model-precedence.js";
import type { AgentWidget } from "../ui/agent-widget.js";
import type { AgentManager } from "../agents/agent-manager.js";
import { CONFIG_AGENT_NON_MODEL_KEYS, type ModelThinkingPlacement } from "./types.js";
import type { SystemPromptMode } from "../agents/types.js";
import type { ThinkingLevel } from "../types.js";
import {
  VALID_SYSTEM_PROMPT_MODES,
  DEFAULT_WATCHDOG_TIMEOUT_MINUTES,
  MIN_FINISHED_RETENTION_MINUTES,
  MODEL_FAMILY_KEYS,
  createConfigIO,
  mergeDefaults,
  mergeLayers,
  type ConfigIO,
  type ConfigTarget,
  type ProjectLayerStatus,
  type RawConfig,
  type RawConcurrency,
} from "./config-io.js";

export type { ConfigIO, ConfigTarget, ProjectLayerStatus, RawConfig, RawConcurrency } from "./config-io.js";

export const fileConfigIO: ConfigIO = createConfigIO();

/** Agent keys that survive clear-all: non-model settings minus the model family. */
const CLEAR_ALL_KEPT_AGENT_KEYS = new Set(CONFIG_AGENT_NON_MODEL_KEYS.filter((key) => !MODEL_FAMILY_KEYS.has(key)));

/** Agent settings with all scalar defaults resolved. Model fields stay nullable. */
export interface ResolvedAgentSettings {
  /** null = inherit parent. Kept nullable to preserve resolveModel's null-skip. */
  readonly defaultModel: string | null;
  readonly forceBackground: boolean;
  readonly showCost: boolean;
  readonly graceTurns: number;
  readonly widgetMaxLines: number;
  readonly widgetMaxLinesCompact: number;
  readonly widgetCompact: boolean;
  readonly showCompletionCards: boolean;
  readonly widgetShortcut: boolean;
  readonly widgetShowModel: boolean;
  readonly widgetShowThinking: boolean;
  readonly widgetNavHint: boolean;

  /** System prompt mode: replace (default), inherit parent, or custom file. */
  readonly systemPromptMode: SystemPromptMode;
  /** Whether to include AGENTS.md context files in the subagent system prompt. */
  readonly includeContextFiles: boolean;
  /** Default thinking level for spawned agents. Undefined = inherit from agent config. */
  readonly defaultThinking: ThinkingLevel | undefined;
  /** Default max turns for spawned agents. Undefined = unlimited. */
  readonly defaultMaxTurns: number | undefined;
  /** Global default for skills loading: true (load all) or false (none). */
  readonly loadSkillsImplicitly: boolean;
  /** Global default for extensions loading: true (load all) or false (none). */
  readonly loadExtensionsImplicitly: boolean;
  /** Whether to skip built-in default agents at registration. */
  readonly disableDefaultAgents: boolean;
  /** Whether to use strict-mode schema for the Agent tool. Costs more tokens. */
  readonly agentToolStrictMode: boolean;
  /** Whether to show toolUses count in widget stats line. */
  readonly showTools: boolean;
  /** Whether to show turn count in widget stats line. */
  readonly showTurns: boolean;
  /** Whether to show input tokens in widget stats line. */
  readonly showInput: boolean;
  /** Whether to show output tokens in widget stats line. */
  readonly showOutput: boolean;
  /** Whether to show context percent and compactions in widget stats line. */
  readonly showContext: boolean;
  /** Whether to show elapsed time in widget stats line. */
  readonly showTime: boolean;
  /** Buffer size for streaming thinking blocks to output file. 0 = disabled. */
  readonly outputThinkingBufferSize: number;
  /** Minutes a finished agent stays visible in the widget after completion. */
  readonly finishedRetentionMinutes: number;
  /** Model display format: 'id' (short) or 'name' (full). */
  readonly modelDisplayStyle: "id" | "name";
  /** Model/thinking placement in full mode: 'header' (1st line) or 'metadata' (2nd line). */
  readonly modelThinkingPlacement: ModelThinkingPlacement;
  /** Status bar format: 'full' (default) or 'compact'. */
  readonly statusBarFormat: "full" | "compact";
  /** Stop an agent when a single tool call runs longer than this (minutes). 0 disables. */
  readonly toolTimeoutMinutes: number;
  /** Stop an agent showing no activity (tool events, streamed text) for this long (minutes). 0 disables. */
  readonly idleTimeoutMinutes: number;
  /** Whether to stream the agent transcript to the output file. Default: false. */
  readonly outputTranscript: boolean;
}

/** Side-effect targets, injected after construction. */
export interface ConfigStoreDeps {
  widget?: AgentWidget;
  manager?: AgentManager;
}

export class ConfigStore {
  private globalRaw: RawConfig;
  private projectRaw: RawConfig | null;
  private projectStatus: ProjectLayerStatus;
  private config: SubagentsConfig;
  private io: ConfigIO;
  private sessionOverrides: SessionModelOverrides = { default: null };
  private sessionConcurrencyLayer: RawConcurrency = {};
  private sessionShowCost: boolean | undefined;
  private widget?: AgentWidget;
  private manager?: AgentManager;
  /** Previous tool-expansion state, for ctrl+o compact sync. */
  private lastToolsExpanded: boolean | undefined;

  constructor(io: ConfigIO = fileConfigIO) {
    this.io = io;
    const loaded = io.load();
    this.globalRaw = loaded.global;
    this.projectRaw = loaded.project;
    this.projectStatus = loaded.projectStatus;
    this.config = mergeDefaults(mergeLayers(this.globalRaw, this.projectRaw));
  }

  /**
   * Point persistence at a project's `.pi` directory (or back to global-only
   * when undefined). Does not reload; session_start follows with reload().
   */
  setProjectDir(projectDir: string | undefined): void {
    this.io = createConfigIO(projectDir);
  }

  // ── Reads ──────────────────────────────────────────────────────

  /** True when the project layer may be written: trusted project, valid or absent file. */
  get projectTargetOffered(): boolean {
    return this.projectStatus === "loaded" || this.projectStatus === "absent";
  }

  get hasSessionShowCost(): boolean {
    return this.sessionShowCost !== undefined;
  }

  get agent(): ResolvedAgentSettings {
    const a = this.config.agent;
    const widgetMaxLines = a.widgetMaxLines!; // guaranteed by the defaults merge
    const widgetMaxLinesCompact = a.widgetMaxLinesCompact ?? Math.floor(widgetMaxLines / 2);

    return {
      defaultModel: a.default ?? null,
      forceBackground: a.forceBackground === true,
      showCost: this.sessionShowCost ?? a.showCost === true,
      graceTurns: a.graceTurns ?? 6,
      widgetMaxLines,
      widgetMaxLinesCompact,
      widgetCompact: a.widgetCompact === true,
      showCompletionCards: a.showCompletionCards !== false,
      widgetShortcut: a.widgetShortcut === true,
      widgetShowModel: a.widgetShowModel !== false,
      widgetShowThinking: a.widgetShowThinking !== false,
      widgetNavHint: a.widgetNavHint !== false,

      systemPromptMode: VALID_SYSTEM_PROMPT_MODES.has(a.systemPromptMode as string)
        ? (a.systemPromptMode as SystemPromptMode)
        : "replace",
      includeContextFiles: a.includeContextFiles ?? true,
      defaultThinking: a.defaultThinking as ThinkingLevel | undefined,
      defaultMaxTurns: a.defaultMaxTurns,
      loadSkillsImplicitly: a.loadSkillsImplicitly !== false,
      loadExtensionsImplicitly: a.loadExtensionsImplicitly !== false,
      disableDefaultAgents: a.disableDefaultAgents === true,
      agentToolStrictMode: a.agentToolStrictMode === true,
      showTools: a.showTools === true,
      showTurns: a.showTurns !== false,
      showInput: a.showInput !== false,
      showOutput: a.showOutput !== false,
      showContext: a.showContext !== false,
      showTime: a.showTime !== false,
      outputThinkingBufferSize: a.outputThinkingBufferSize ?? 0,
      finishedRetentionMinutes: Math.max(MIN_FINISHED_RETENTION_MINUTES, a.finishedRetentionMinutes ?? 1),
      modelDisplayStyle: a.modelDisplayStyle === "id" ? "id" : "name",
      modelThinkingPlacement: a.modelThinkingPlacement === "metadata" ? "metadata" : "header",
      statusBarFormat: a.statusBarFormat === "compact" ? "compact" : "full",
      toolTimeoutMinutes: a.toolTimeoutMinutes ?? DEFAULT_WATCHDOG_TIMEOUT_MINUTES,
      idleTimeoutMinutes: a.idleTimeoutMinutes ?? DEFAULT_WATCHDOG_TIMEOUT_MINUTES,
      outputTranscript: a.outputTranscript === true,
    };
  }

  get concurrency(): {
    default: number;
    providers: Record<string, number>;
    models: Record<string, number>;
  } {
    const base = this.config.concurrency;
    const session = this.sessionConcurrencyLayer;
    return {
      default: session.default ?? base.default,
      providers: { ...(base.providers ?? {}), ...(session.providers ?? {}) },
      models: { ...(base.models ?? {}), ...(session.models ?? {}) },
    };
  }

  get sessionDefaultModel(): string | null {
    return this.sessionOverrides.default ?? null;
  }

  sessionModelOverride(type: string): string | null {
    return this.sessionOverrides[type] ?? null;
  }

  /** Whether the global agent layer carries this key (provenance from layer membership). */
  hasGlobalModelKey(key: string): boolean {
    return this.globalRaw.agent != null && this.globalRaw.agent[key] !== undefined;
  }

  /** Whether the project agent layer carries this key (provenance from layer membership). */
  hasProjectModelKey(key: string): boolean {
    return this.projectRaw?.agent != null && this.projectRaw.agent[key] !== undefined;
  }

  get projectConcurrency(): RawConcurrency {
    return { ...(this.projectRaw?.concurrency ?? {}) };
  }

  get sessionConcurrency(): RawConcurrency {
    return { ...this.sessionConcurrencyLayer };
  }

  /** Raw agent config incl. dynamic per-type model keys (for menu display). */
  agentConfigSnapshot(): Readonly<SubagentsConfig["agent"]> {
    return this.config.agent;
  }

  /**
   * Resolve the effective model for a spawn, hiding resolveModel's option
   * assembly. Precedence: session per-type → session default → config per-type
   * → config default → agentConfig (frontmatter) → parentModelId.
   */
  modelFor(type: string, parentModelId: string, agentConfig?: { model?: string }): string {
    return resolveModel({
      subagentType: type,
      agentConfig,
      config: this.config,
      parentModelId,
      sessionOverrides: this.sessionOverrides,
    });
  }

  // ── Mutations ──────────────────────────────────────────────────
  // Session methods are in-memory only: never persisted, no side effects.
  // Target-aware methods default to the global layer; "all" clears the key or
  // the model set in every layer that offers a project target.

  readonly mutate = {
    agent: {
      setDefaultModel: (value: string | null, target: ConfigTarget = "global"): void => {
        this.setAgentModelKey("default", value, target);
      },
      setModelOverride: (type: string, value: string | null, target: ConfigTarget = "global"): void => {
        this.setAgentModelKey(type, value, target);
      },
      clearModelOverride: (type: string, target: ConfigTarget | "all" = "global"): void => {
        this.clearAtTarget(
          target,
          () => {
            delete this.sessionOverrides[type];
          },
          (layer) => {
            if (layer.agent) delete layer.agent[type];
          },
        );
      },
      /** Clear all model keys (default, thinking, max turns, per-type), keeping non-model settings. */
      clearAllModelOverrides: (target: ConfigTarget | "all" = "global"): void => {
        this.clearAtTarget(
          target,
          () => {
            this.sessionOverrides = { default: null };
          },
          (layer) => this.clearAgentModelKeys(layer),
        );
      },
      setForceBackground: (enabled: boolean) => this.setAgentLayerEntry("forceBackground", enabled, "global"),
      setShowCost: (enabled: boolean): void => {
        this.globalAgent().showCost = enabled;
        this.sessionShowCost = undefined;
        this.commitGlobal();
        this.widget?.setShowCost(enabled);
        this.syncWidgetStatsVisibility();
      },
      setGraceTurns: (n: number) => this.setAgentLayerEntry("graceTurns", n, "global"),
      setToolTimeoutMinutes: (n: number) => this.setAgentLayerEntry("toolTimeoutMinutes", Math.max(0, n), "global"),
      setIdleTimeoutMinutes: (n: number) => this.setAgentLayerEntry("idleTimeoutMinutes", Math.max(0, n), "global"),
      setOutputTranscript: (enabled: boolean) => this.setAgentLayerEntry("outputTranscript", enabled, "global"),
      setSystemPromptMode: (mode: SystemPromptMode) => this.setAgentLayerEntry("systemPromptMode", mode, "global"),
      setIncludeContextFiles: (enabled: boolean) => this.setAgentLayerEntry("includeContextFiles", enabled, "global"),
      setDefaultThinking: (level: ThinkingLevel | undefined, target: "global" | "project" = "global"): void => {
        this.setAgentLayerEntry("defaultThinking", level, target);
      },
      setDefaultMaxTurns: (n: number | undefined, target: "global" | "project" = "global"): void => {
        this.setAgentLayerEntry("defaultMaxTurns", n, target);
      },
      /** Delete defaultMaxTurns at a persisted layer (or every layer) so the value falls through. */
      clearDefaultMaxTurns: (target: "global" | "project" | "all" = "global"): void => {
        this.clearAtTarget(
          target,
          () => {
            // Spawn defaults have no session layer; "all" clears only the persisted layers.
          },
          (layer) => {
            if (layer.agent) delete layer.agent.defaultMaxTurns;
          },
        );
      },
      setLoadSkillsImplicitly: (value: boolean) => this.setAgentLayerEntry("loadSkillsImplicitly", value, "global"),
      setLoadExtensionsImplicitly: (value: boolean) =>
        this.setAgentLayerEntry("loadExtensionsImplicitly", value, "global"),
      setDisableDefaultAgents: (value: boolean) => this.setAgentLayerEntry("disableDefaultAgents", value, "global"),
      setAgentToolStrictMode: (value: boolean) => this.setAgentLayerEntry("agentToolStrictMode", value, "global"),
      setShowTools: (enabled: boolean) => this.setAgentVisibility("showTools", enabled),
      setShowTurns: (enabled: boolean) => this.setAgentVisibility("showTurns", enabled),
      setShowInput: (enabled: boolean) => this.setAgentVisibility("showInput", enabled),
      setShowOutput: (enabled: boolean) => this.setAgentVisibility("showOutput", enabled),
      setShowContext: (enabled: boolean) => this.setAgentVisibility("showContext", enabled),
      setShowTime: (enabled: boolean) => this.setAgentVisibility("showTime", enabled),
      setOutputThinkingBufferSize: (size: number) =>
        this.setAgentLayerEntry("outputThinkingBufferSize", size, "global"),
      setFinishedRetentionMinutes: (minutes: number): void => {
        const n = Math.max(MIN_FINISHED_RETENTION_MINUTES, minutes);
        this.setAgentLayerEntry("finishedRetentionMinutes", n, "global");
        // Push the window to the widget so it applies on the next render tick.
        this.widget?.setFinishedRetentionMinutes(n);
      },
    },
    widget: {
      setCompact: (enabled: boolean): void => {
        this.setAgentLayerEntry("widgetCompact", enabled, "global");
        this.syncWidgetSettings();
      },
      setShowCompletionCards: (enabled: boolean) => this.setAgentLayerEntry("showCompletionCards", enabled, "global"),
      setMaxLines: (lines: number): void => {
        this.globalAgent().widgetMaxLines = lines;
        if (this.globalAgent().widgetMaxLinesCompact === undefined) {
          this.globalAgent().widgetMaxLinesCompact = Math.floor(lines / 2);
        }
        this.commitGlobal();
        this.syncWidgetSettings();
      },
      setMaxLinesCompact: (lines: number): void => {
        this.setAgentLayerEntry("widgetMaxLinesCompact", lines, "global");
        this.syncWidgetSettings();
      },

      // Note: persists only. Does NOT syncWidgetSettings — matches the existing
      // behavior, where toggling the shortcut takes effect on next reload rather
      // than immediately. Flagged for a follow-up (the other three widget
      // setters do sync).
      setShortcut: (enabled: boolean) => this.setAgentLayerEntry("widgetShortcut", enabled, "global"),
      setShowModel: (enabled: boolean): void => {
        this.setAgentLayerEntry("widgetShowModel", enabled, "global");
        this.syncWidgetStatsVisibility();
      },
      setShowThinking: (enabled: boolean): void => {
        this.setAgentLayerEntry("widgetShowThinking", enabled, "global");
        this.syncWidgetStatsVisibility();
      },
      setNavHint: (enabled: boolean): void => {
        this.setAgentLayerEntry("widgetNavHint", enabled, "global");
        this.syncWidgetSettings();
      },
      setModelDisplayStyle: (style: "id" | "name"): void => {
        this.setAgentLayerEntry("modelDisplayStyle", style, "global");
        this.syncWidgetSettings();
      },
      setModelThinkingPlacement: (placement: ModelThinkingPlacement): void => {
        this.setAgentLayerEntry("modelThinkingPlacement", placement, "global");
        this.syncWidgetSettings();
      },
      setStatusBarFormat: (format: "full" | "compact"): void => {
        this.setAgentLayerEntry("statusBarFormat", format, "global");
        this.syncWidgetSettings();
      },
    },
    concurrency: {
      setDefault: (n: number, target: ConfigTarget = "global"): void => {
        this.applyConcurrencyWrite(target, (layer) => {
          layer.default = n;
        });
      },
      setProvider: (key: string, n: number, target: ConfigTarget = "global"): void => {
        this.applyConcurrencyWrite(target, (layer) => {
          layer.providers = { ...(layer.providers ?? {}), [key]: n };
        });
      },
      setModel: (key: string, n: number, target: ConfigTarget = "global"): void => {
        this.applyConcurrencyWrite(target, (layer) => {
          layer.models = { ...(layer.models ?? {}), [key]: n };
        });
      },
      removeProvider: (key: string, target: ConfigTarget | "all" = "global"): void => {
        this.removeConcurrencyEntry("providers", key, target);
      },
      removeDefault: (target: ConfigTarget | "all" = "global"): void => {
        this.removeConcurrencyEntry("default", undefined, target);
      },
      removeModel: (key: string, target: ConfigTarget | "all" = "global"): void => {
        this.removeConcurrencyEntry("models", key, target);
      },
      /** Remove every concurrency key at the target level; effective values fall through. */
      clearAll: (target: ConfigTarget | "all" = "global"): void => {
        this.clearAtTarget(
          target,
          () => {
            this.sessionConcurrencyLayer = {};
          },
          (layer) => {
            delete layer.concurrency;
          },
          () => this.applyConcurrency(),
        );
      },
    },
    session: {
      /** Not persisted; key "default" sets the session-wide default. */
      setOverride: (type: string, model: string): void => {
        this.sessionOverrides[type] = model;
      },
      clearOverride: (type: string): void => {
        delete this.sessionOverrides[type];
      },
      clearAll: (): void => {
        this.sessionOverrides = { default: null };
      },
      /** Not persisted. */
      setShowCost: (enabled: boolean): void => {
        this.sessionShowCost = enabled;
        this.widget?.setShowCost(enabled);
        this.syncWidgetStatsVisibility();
      },
      /** Revert to config value. */
      clearShowCost: (): void => {
        this.sessionShowCost = undefined;
        this.widget?.setShowCost(this.config.agent.showCost === true);
        this.syncWidgetStatsVisibility();
      },
    },
  };

  // ── ctrl+o compact sync (absorbs syncCompactFromToolsExpanded) ──

  /**
   * Toggle widget compact mode when tool expansion changes (ctrl+o), gated on
   * widgetShortcut. No-op when widgetCompact is forced on. Only acts on actual
   * state transitions (not every call).
   */
  notifyToolsExpanded(expanded: boolean): void {
    if (this.config.agent.widgetShortcut !== true) {
      this.lastToolsExpanded = expanded;
      return;
    }
    if (this.config.agent.widgetCompact === true) {
      this.lastToolsExpanded = expanded;
      return;
    }
    if (this.lastToolsExpanded !== undefined && this.lastToolsExpanded !== expanded) {
      this.widget?.setCompactMode(!expanded);
    }
    this.lastToolsExpanded = expanded;
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  /** Re-read disk, reset session overrides + toggle state, re-sync deps. Called at session_start. */
  reload(): void {
    const loaded = this.io.load();
    this.globalRaw = loaded.global;
    this.projectRaw = loaded.project;
    this.projectStatus = loaded.projectStatus;
    this.rebuildEffective();
    this.sessionOverrides = { default: null };
    this.sessionConcurrencyLayer = {};
    this.sessionShowCost = undefined;
    this.lastToolsExpanded = undefined;
    this.syncAllDeps();
  }

  /** Inject side-effect targets. Re-syncs whatever deps are present (lazy widget/manager). */
  setDeps(deps: ConfigStoreDeps): void {
    if (deps.widget !== undefined) this.widget = deps.widget;
    if (deps.manager !== undefined) this.manager = deps.manager;
    this.syncAllDeps();
  }

  /** Drop deps at session_shutdown. The widget/manager are disposed by the composition root. */
  dispose(): void {
    this.widget = undefined;
    this.manager = undefined;
  }

  // ── Private helpers ────────────────────────────────────────────

  /**
   * The raw layer a persisted mutation targets. The project layer is created
   * empty on first access in a trusted project without a file (the first write
   * creates the file); when the project target is unavailable (untrusted or
   * malformed) the mutation is refused with a warning.
   */
  private layerFor(target: "global" | "project"): RawConfig | null {
    if (target === "global") return this.globalRaw;
    if (this.projectRaw) return this.projectRaw;
    if (this.projectStatus === "absent") {
      this.projectRaw = {};
      return this.projectRaw;
    }
    console.warn(`[subagents] Project config target unavailable (${this.projectStatus}); change ignored`);
    return null;
  }

  /** Write an agent key at a persisted layer; undefined deletes it. */
  private setAgentLayerEntry(key: string, value: unknown, target: "global" | "project"): void {
    const layer = this.layerFor(target);
    if (!layer) return;
    layer.agent ??= {};
    if (value === undefined) delete layer.agent[key];
    else layer.agent[key] = value;
    this.commitLayer(target, layer);
  }

  /** Write a model key (default or per-type) at the target layer; session writes are in-memory. */
  private setAgentModelKey(key: string, value: string | null, target: ConfigTarget): void {
    if (target === "session") {
      this.sessionOverrides[key] = value;
      return;
    }
    this.setAgentLayerEntry(key, value, target);
  }

  /** Write a concurrency value into the target layer, then persist and re-sync the manager. */
  private applyConcurrencyWrite(target: ConfigTarget, write: (layer: RawConcurrency) => void): void {
    if (target === "session") {
      write(this.sessionConcurrencyLayer);
      this.applyConcurrency();
      return;
    }
    const layer = this.layerFor(target);
    if (!layer) return;
    layer.concurrency ??= {};
    write(layer.concurrency);
    this.commitLayer(target, layer);
    this.applyConcurrency();
  }

  private globalAgent(): Record<string, unknown> {
    this.globalRaw.agent ??= {};
    return this.globalRaw.agent;
  }

  private commitGlobal(): void {
    this.io.saveGlobal(this.globalRaw);
    this.rebuildEffective();
  }

  private commitLayer(target: "global" | "project", layer: RawConfig): void {
    if (target === "global") this.io.saveGlobal(layer);
    else this.io.saveProject(layer);
    this.rebuildEffective();
  }

  private rebuildEffective(): void {
    this.config = mergeDefaults(mergeLayers(this.globalRaw, this.projectRaw));
  }

  private clearAgentModelKeys(layer: RawConfig): void {
    if (!layer.agent) return;
    for (const key of Object.keys(layer.agent)) {
      if (!CLEAR_ALL_KEPT_AGENT_KEYS.has(key)) delete layer.agent[key];
    }
  }

  /**
   * Clear the same model/concurrency key set at one target: session
   * (in-memory), a persisted layer (saved), or every layer (global saved
   * first, then project when offered; effective config rebuilt).
   * `after` runs after any branch.
   */
  private clearAtTarget(
    target: ConfigTarget | "all",
    sessionClear: () => void,
    layerClear: (layer: RawConfig) => void,
    after?: () => void,
  ): void {
    if (target === "session") {
      sessionClear();
      after?.();
      return;
    }
    if (target === "all") {
      sessionClear();
      layerClear(this.globalRaw);
      this.io.saveGlobal(this.globalRaw);
      this.withProjectLayer(layerClear);
      this.rebuildEffective();
      after?.();
      return;
    }
    const layer = this.layerFor(target);
    if (!layer) return;
    layerClear(layer);
    this.commitLayer(target, layer);
    after?.();
  }

  /**
   * Run a write against an existing project layer, persisting it after.
   * Skips when no project file exists: a clear must never create one (sets
   * create the layer via layerFor).
   */
  private withProjectLayer(write: (layer: RawConfig) => void): void {
    if (!this.projectRaw) return;
    write(this.projectRaw);
    this.io.saveProject(this.projectRaw);
  }

  private removeConcurrencyEntry(
    section: "default" | "providers" | "models",
    key: string | undefined,
    target: ConfigTarget | "all",
  ): void {
    const removeFrom = (layer: RawConcurrency | undefined): void => {
      if (!layer) return;
      if (section === "default") {
        delete layer.default;
      } else if (key) {
        const entries = layer[section];
        if (entries) delete entries[key];
      }
    };
    this.clearAtTarget(
      target,
      () => removeFrom(this.sessionConcurrencyLayer),
      (layer) => removeFrom(layer.concurrency),
      () => this.applyConcurrency(),
    );
  }

  private syncWidgetSettings(): void {
    const w = this.widget;
    if (!w) return;
    const a = this.agent;
    w.setForceCompact(a.widgetCompact);
    w.setWidgetShortcut(a.widgetShortcut);
    w.setMaxLines(a.widgetMaxLines);
    w.setMaxLinesCompact(a.widgetMaxLinesCompact);

    w.setNavHint(a.widgetNavHint);
    w.setFinishedRetentionMinutes(a.finishedRetentionMinutes);
    w.setModelDisplayStyle(a.modelDisplayStyle);
    w.setStatusBarFormat(a.statusBarFormat);
    w.setModelThinkingPlacement(a.modelThinkingPlacement);
  }

  private syncWidgetStatsVisibility(): void {
    const w = this.widget;
    if (!w) return;
    const a = this.agent;
    w.setStatsVisibility({
      showTools: a.showTools,
      showTurns: a.showTurns,
      showInput: a.showInput,
      showOutput: a.showOutput,
      showContext: a.showContext,
      showCost: a.showCost,
      showTime: a.showTime,
      showModel: a.widgetShowModel,
      showThinking: a.widgetShowThinking,
    });
  }

  private setAgentVisibility(
    key: "showTools" | "showTurns" | "showInput" | "showOutput" | "showContext" | "showTime",
    value: boolean,
  ): void {
    this.setAgentLayerEntry(key, value, "global");
    this.syncWidgetStatsVisibility();
  }

  private applyConcurrency(): void {
    this.manager?.setConcurrency(this.concurrency);
  }

  private syncAllDeps(): void {
    if (this.widget) {
      this.widget.setShowCost(this.agent.showCost);
      this.syncWidgetSettings();
      this.syncWidgetStatsVisibility();
    }
    this.applyConcurrency();
  }
}
