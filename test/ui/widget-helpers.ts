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
import type { AgentRecord } from "../../src/types.js";
import type { AgentWidget, UICtx } from "../../src/ui/agent-widget.js";

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
