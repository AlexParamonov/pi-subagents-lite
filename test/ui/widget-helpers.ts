/**
 * widget-helpers.ts — Shared test infrastructure for AgentWidget suites.
 *
 * `renderWidgetLines` drives the widget's public render seam instead of
 * reaching into the private renderWidget method: setUICtx + update()
 * registers the widget factory on the UI context; invoking that factory's
 * render() returns the produced lines. When no agents exist, update()
 * unregisters the widget instead of rendering, and the helper returns [].
 * One UI context is kept per widget, as production does: a fresh context on
 * every render would drop the widget's per-agent sample caches.
 */

import type { Theme } from "../../src/ui/types.js";
import type { AgentManager } from "../../src/agents/agent-manager.js";
import type { AgentRecord, LiveView } from "../../src/types.js";
import type { AgentWidget, UICtx } from "../../src/ui/agent-widget.js";
import type { AgentInvocation } from "../../src/agents/types.js";
import { asAgentSession } from "../pi-boundaries.js";

/** The minimal TUI shape the widget render path reads. */
export interface MockTUI {
  terminal: { columns: number };
}

export function makeMockTheme(): Theme {
  return {
    fg: (color: string, text: string) => `[${color}:${text}]`,
    bg: (color: string, text: string) => text,
    bold: (text: string) => `**${text}**`,
  };
}

export function makeMockTUI(): MockTUI {
  return { terminal: { columns: 200 } };
}

/* ------------------------------------------------------------------ */
/*  Agent record factories                                             */
/* ------------------------------------------------------------------ */

export interface AgentFactoryOpts {
  type?: string;
  worktreeLabel?: string;
  outputFile?: string;
  invocation?: AgentInvocation;
  withSession?: boolean;
}

export function makeRunningAgent(id: string, opts?: AgentFactoryOpts): AgentRecord {
  return {
    id,
    display: {
      type: (opts?.type ?? "builder") as AgentRecord["display"]["type"],
      description: `Test agent ${id}`,
      worktreeLabel: opts?.worktreeLabel,
      outputFile: opts?.outputFile,
      invocation: opts?.invocation,
    },
    lifecycle: { status: "running", startedAt: Date.now() - 60_000, started: true },
    execution: {
      settled: false,
      settlementCount: 0,
      session: opts?.withSession
        ? (asAgentSession({
            model: { id: "haiku", name: "Haiku" },
            thinkingLevel: "medium",
            // A session that cannot say which session it is makes the bash sampling path bail out
            // through its catch, which would hide a real fixture mistake behind a generic line.
            sessionManager: { getSessionId: () => `session-${id}` },
          }) as never)
        : undefined,
    },
    stats: {
      toolUses: 5,
      compactionCount: 0,
      lifetimeUsage: { input: 1000, output: 500, cacheWrite: 0, cost: 0 },
      turnCount: 3,
      maxTurns: 30,
    },
  };
}

export function makeFinishedAgent(id: string, opts?: AgentFactoryOpts): AgentRecord {
  return {
    id,
    display: {
      type: (opts?.type ?? "builder") as AgentRecord["display"]["type"],
      description: `Finished agent ${id}`,
      worktreeLabel: opts?.worktreeLabel,
      outputFile: opts?.outputFile,
      invocation: opts?.invocation,
    },
    lifecycle: {
      status: "completed",
      startedAt: Date.now() - 120_000,
      completedAt: Date.now() - 30_000,
      started: true,
    },
    execution: {
      settled: false,
      settlementCount: 0,
      session: opts?.withSession
        ? (asAgentSession({
            model: { id: "haiku", name: "Haiku" },
            thinkingLevel: "medium",
            // A session that cannot say which session it is makes the bash sampling path bail out
            // through its catch, which would hide a real fixture mistake behind a generic line.
            sessionManager: { getSessionId: () => `session-${id}` },
          }) as never)
        : undefined,
    },
    stats: {
      toolUses: 10,
      compactionCount: 0,
      lifetimeUsage: { input: 2000, output: 1000, cacheWrite: 0, cost: 0 },
      turnCount: 8,
      maxTurns: 30,
    },
  };
}

export function makeQueuedAgent(id: string, opts?: { type?: string }): AgentRecord {
  return {
    id,
    display: {
      type: (opts?.type ?? "builder") as AgentRecord["display"]["type"],
      description: `Queued agent ${id}`,
    },
    lifecycle: { status: "queued", startedAt: Date.now() - 30_000, started: false },
    execution: { settled: false, settlementCount: 0 },
    stats: {
      toolUses: 0,
      compactionCount: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      turnCount: 0,
      maxTurns: 30,
    },
  };
}

/** A remote Workflow run: no session, so no live view feeds its row. */
export function makeWorkflowRun(id: string, opts?: { note?: string; progress?: string[] }): AgentRecord {
  return {
    id,
    display: { type: "audit" as AgentRecord["display"]["type"], description: "audit the diff" },
    lifecycle: { status: "running", startedAt: Date.now() - 60_000, started: true },
    execution: { settled: false, settlementCount: 0 },
    workflow: {
      name: "audit",
      remoteId: `wf-${id}`,
      progress: opts?.progress ?? [],
      ...(opts?.note ? { note: opts.note } : {}),
    },
    stats: {
      toolUses: 0,
      compactionCount: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
    },
  };
}

export function makeActivity(_agentId: string): LiveView {
  return { activeTools: new Map([["read", "reading"]]), responseText: "" };
}

export function makeMockManager(agents: AgentRecord[], totalAgentCost = 0, totalAgentCount = 0): AgentManager {
  const m = {
    listAgents: () => agents,
    getTotalAgentCost: () => totalAgentCost,
    getTotalAgentCount: () => totalAgentCount,
    getToolStartedAt: (_agentId: string, _toolCallId: string): number | undefined => undefined,
  };
  // The stub implements only what AgentWidget reads (listAgents, cost/count
  // totals). AgentManager has private members, so the single `as` cast
  // relies on this shape staying comparable to the real class. The real
  // setConcurrency(config: ConcurrencyConfig) is omitted: widget tests never
  // call it, and a zero-arg stub is not comparable to that signature.
  return m as AgentManager;
}

/** Render the widget through its public update() -> setWidget -> render() seam.
 * Accepts a custom TUI (e.g. narrow terminal widths) or theme.
 */
const widgetHosts = new WeakMap<AgentWidget, { ctx: UICtx; factory?: WidgetContent }>();

type WidgetContent = NonNullable<Parameters<UICtx["setWidget"]>[1]>;

export function renderWidgetLines(
  widget: AgentWidget,
  tui: MockTUI = makeMockTUI(),
  theme: Theme = makeMockTheme(),
): string[] {
  let host = widgetHosts.get(widget);
  if (!host) {
    const created: { ctx: UICtx; factory?: WidgetContent } = {
      ctx: {
        setStatus: () => {},
        setWidget: (_key, content) => {
          created.factory = content ?? undefined;
        },
      },
    };
    widgetHosts.set(widget, created);
    host = created;
    widget.setUICtx(host.ctx);
  }
  widget.update();
  return host.factory ? host.factory(tui, theme).render() : [];
}
