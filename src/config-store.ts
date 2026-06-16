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
 *
 * Lifecycle: per-session. `reload()` re-reads disk + resets session overrides
 * at session_start. `dispose()` drops deps at session_shutdown.
 */

import type { SubagentsConfig, SessionModelOverrides } from "./model-precedence.js";
import { resolveModel } from "./model-precedence.js";
import type { AgentWidget } from "./ui/agent-widget.js";
import type { AgentManager } from "./agent-manager.js";
import { CONFIG_AGENT_NON_MODEL_KEYS } from "./types.js";
import { DEFAULT_CONFIG, loadConfig, saveConfigAtomic } from "./config-io.js";

/** Injected persistence adapter. Swap for an in-memory adapter in tests. */
export interface ConfigIO {
  load(): SubagentsConfig;
  save(config: SubagentsConfig): void;
}

/** Production adapter wrapping the real config file. */
export const fileConfigIO: ConfigIO = {
  load: () => loadConfig(),
  save: (c) => saveConfigAtomic(c),
};

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
  readonly widgetShortcut: boolean;
}

/** Side-effect targets, injected after construction. */
export interface ConfigStoreDeps {
  widget?: AgentWidget;
  manager?: AgentManager;
}

export class ConfigStore {
  private config: SubagentsConfig;
  private sessionOverrides: SessionModelOverrides = { default: null };
  private widget?: AgentWidget;
  private manager?: AgentManager;
  /** Previous tool-expansion state, for ctrl+o compact sync. */
  private lastToolsExpanded: boolean | undefined;

  constructor(private readonly io: ConfigIO = fileConfigIO) {
    this.config = this.io.load();
  }

  // ── Reads ──────────────────────────────────────────────────────

  get agent(): ResolvedAgentSettings {
    const a = this.config.agent;
    const widgetMaxLines = a.widgetMaxLines ?? DEFAULT_CONFIG.agent.widgetMaxLines ?? 12;
    return {
      defaultModel: a.default ?? null,
      forceBackground: a.forceBackground === true,
      showCost: a.showCost === true,
      graceTurns: a.graceTurns ?? DEFAULT_CONFIG.agent.graceTurns ?? 6,
      widgetMaxLines,
      widgetMaxLinesCompact: a.widgetMaxLinesCompact ?? Math.floor(widgetMaxLines / 2),
      widgetCompact: a.widgetCompact === true,
      widgetShortcut: a.widgetShortcut === true,
    };
  }

  get concurrency(): {
    default: number;
    providers: Record<string, number>;
    models: Record<string, number>;
  } {
    return {
      default: this.config.concurrency.default,
      providers: this.config.concurrency.providers ?? {},
      models: this.config.concurrency.models ?? {},
    };
  }

  get sessionDefaultModel(): string | null {
    return this.sessionOverrides.default ?? null;
  }

  sessionModelOverride(type: string): string | null {
    return this.sessionOverrides[type] ?? null;
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
  // Each persisted method = mutate + persist (+ side effect). Session methods
  // are in-memory only: never persisted, no side effects.

  readonly mutate = {
    agent: {
      setDefaultModel: (value: string | null): void => {
        this.config.agent.default = value;
        this.persist();
      },
      setModelOverride: (type: string, value: string | null): void => {
        this.config.agent[type] = value;
        this.persist();
      },
      clearModelOverride: (type: string): void => {
        delete this.config.agent[type];
        this.persist();
      },
      /** Clear all per-type model overrides, preserving non-model settings. */
      clearAllModelOverrides: (): void => {
        const preserved: Record<string, unknown> = {};
        for (const key of CONFIG_AGENT_NON_MODEL_KEYS) {
          const val = this.config.agent[key];
          if (val != null || key === "default" || key === "forceBackground") {
            preserved[key] = val;
          }
        }
        this.config.agent = preserved as SubagentsConfig["agent"];
        this.persist();
        this.syncWidgetSettings();
      },
      setForceBackground: (enabled: boolean): void => {
        this.config.agent.forceBackground = enabled;
        this.persist();
      },
      setShowCost: (enabled: boolean): void => {
        this.config.agent.showCost = enabled;
        this.persist();
        this.widget?.setShowCost(enabled);
      },
      setGraceTurns: (n: number): void => {
        this.config.agent.graceTurns = n;
        this.persist();
      },
    },
    widget: {
      setCompact: (enabled: boolean): void => {
        this.config.agent.widgetCompact = enabled;
        this.persist();
        this.syncWidgetSettings();
      },
      setMaxLines: (lines: number): void => {
        this.config.agent.widgetMaxLines = lines;
        if (this.config.agent.widgetMaxLinesCompact === undefined) {
          this.config.agent.widgetMaxLinesCompact = Math.floor(lines / 2);
        }
        this.persist();
        this.syncWidgetSettings();
      },
      setMaxLinesCompact: (lines: number): void => {
        this.config.agent.widgetMaxLinesCompact = lines;
        this.persist();
        this.syncWidgetSettings();
      },
      // Note: persists only. Does NOT syncWidgetSettings — matches the existing
      // behavior, where toggling the shortcut takes effect on next reload rather
      // than immediately. Flagged for a follow-up (the other three widget
      // setters do sync).
      setShortcut: (enabled: boolean): void => {
        this.config.agent.widgetShortcut = enabled;
        this.persist();
      },
    },
    concurrency: {
      setDefault: (n: number): void => {
        this.config.concurrency.default = n;
        this.persist();
        this.applyConcurrency();
      },
      setProvider: (key: string, n: number): void => {
        this.config.concurrency.providers = { ...(this.config.concurrency.providers ?? {}), [key]: n };
        this.persist();
        this.applyConcurrency();
      },
      setModel: (key: string, n: number): void => {
        this.config.concurrency.models = { ...(this.config.concurrency.models ?? {}), [key]: n };
        this.persist();
        this.applyConcurrency();
      },
      removeProvider: (key: string): void => {
        if (this.config.concurrency.providers) delete this.config.concurrency.providers[key];
        this.persist();
        this.applyConcurrency();
      },
      removeModel: (key: string): void => {
        if (this.config.concurrency.models) delete this.config.concurrency.models[key];
        this.persist();
        this.applyConcurrency();
      },
      reset: (): void => {
        this.config.concurrency = { ...DEFAULT_CONFIG.concurrency };
        this.persist();
        this.applyConcurrency();
      },
    },
    session: {
      /** Set a session model override for a type (or "default"). Not persisted. */
      setOverride: (type: string, model: string): void => {
        this.sessionOverrides[type] = model;
      },
      clearOverride: (type: string): void => {
        delete this.sessionOverrides[type];
      },
      clearAll: (): void => {
        this.sessionOverrides = { default: null };
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
    this.config = this.io.load();
    this.sessionOverrides = { default: null };
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

  private persist(): void {
    this.io.save(this.config);
  }

  /** Push widget display settings (compact, shortcut, max lines) to the widget. */
  private syncWidgetSettings(): void {
    const w = this.widget;
    if (!w) return;
    const a = this.agent;
    w.setForceCompact(a.widgetCompact);
    w.setWidgetShortcut(a.widgetShortcut);
    w.setMaxLines(a.widgetMaxLines);
    w.setMaxLinesCompact(a.widgetMaxLinesCompact);
  }

  private applyConcurrency(): void {
    this.manager?.setConcurrency(this.config.concurrency);
  }

  /** Full re-sync of all present deps. Used by reload/setDeps. */
  private syncAllDeps(): void {
    if (this.widget) {
      this.widget.setShowCost(this.agent.showCost);
      this.syncWidgetSettings();
    }
    this.applyConcurrency();
  }
}
