/**
 * widget-helpers.ts — Shared test infrastructure for AgentWidget suites.
 *
 * `renderWidgetLines` drives the widget's public render seam instead of
 * reaching into the private renderWidget method: setUICtx + update()
 * registers the widget factory on the UI context; invoking that factory's
 * render() returns the produced lines. When no agents exist, update()
 * unregisters the widget instead of rendering, and the helper returns [].
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
        ? (asAgentSession({ model: { id: "haiku", name: "Haiku" }, thinkingLevel: "medium" }) as never)
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
        ? (asAgentSession({ model: { id: "haiku", name: "Haiku" }, thinkingLevel: "medium" }) as never)
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

export function makeActivity(_agentId: string): LiveView {
  return { activeTools: new Map([["read", "reading"]]), responseText: "" };
}

export function makeMockManager(agents: AgentRecord[], totalAgentCost = 0, totalAgentCount = 0): AgentManager {
  const m = {
    listAgents: () => agents,
    getTotalAgentCost: () => totalAgentCost,
    getTotalAgentCount: () => totalAgentCount,
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
export function renderWidgetLines(
  widget: AgentWidget,
  tui: MockTUI = makeMockTUI(),
  theme: Theme = makeMockTheme(),
): string[] {
  // The setWidget content factory, captured from the public UICtx seam.
  type WidgetContent = NonNullable<Parameters<UICtx["setWidget"]>[1]>;
  let factory: WidgetContent | undefined;
  const ctx: UICtx = {
    setWidget: (_key, content) => {
      factory = content;
    },
    setStatus: () => {},
  };
  widget.setUICtx(ctx);
  widget.update();
  return factory ? factory(tui, theme).render() : [];
}
