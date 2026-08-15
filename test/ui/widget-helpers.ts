/**
 * widget-helpers.ts — Shared test infrastructure for AgentWidget suites.
 *
 * `renderWidgetLines` drives the widget's public render seam instead of
 * reaching into the private renderWidget method: setUICtx + update()
 * registers the widget factory on the UI context; invoking that factory's
 * render() returns the produced lines. When no agents exist, update()
 * unregisters the widget instead of rendering, and the helper returns [].
 */

import type { AgentManager } from "../../src/agents/agent-manager.js";
import type { AgentWidget } from "../../src/ui/agent-widget.js";

export function makeMockTheme(): any {
  return {
    fg: (color: string, text: string) => `[${color}:${text}]`,
    bold: (text: string) => `**${text}**`,
  };
}

export function makeMockTUI(): any {
  return { terminal: { columns: 200 } };
}

export function makeMockManager(agents: any[], totalAgentCost = 0, totalAgentCount = 0): AgentManager {
  return {
    listAgents: () => agents,
    getAgent: () => undefined,
    setConcurrency: () => {},
    getTotalAgentCost: () => totalAgentCost,
    getTotalAgentCount: () => totalAgentCount,
  } as any as AgentManager;
}

/** Render the widget through its public update() -> setWidget -> render() seam.
 * Accepts a custom TUI (e.g. narrow terminal widths) or theme.
 */
export function renderWidgetLines(
  widget: AgentWidget,
  tui: any = makeMockTUI(),
  theme: any = makeMockTheme(),
): string[] {
  let factory: ((tui: any, theme: any) => { render(): string[] }) | undefined;
  const ctx = {
    setWidget: (_key: string, content: any) => {
      factory = content;
    },
    setStatus: () => {},
  };
  widget.setUICtx(ctx as any);
  widget.update();
  return factory ? factory(tui, theme).render() : [];
}
