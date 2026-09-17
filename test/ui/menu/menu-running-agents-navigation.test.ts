import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Component } from "@earendil-works/pi-tui";
import { mockModules, resetConfig } from "../../menu-mock-setup.js";
import { createMockCtx, type ComponentFactory } from "../../menu-test-helpers.js";
import { makeFinishedAgent, makeRunningAgent } from "../widget-helpers.js";
import { showRunningAgentsMenu } from "../../../src/ui/menu/menu-running-agents.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const WIDTH = 100;

async function openMenu() {
  let component: Component | undefined;
  const closed = vi.fn();
  const ctx = createMockCtx([], [], [], {
    ui: {
      custom: async (factory: ComponentFactory) => {
        const result = await factory(
          { terminal: { rows: 40 } },
          { fg: (_color, text) => text, bold: (text) => text },
          undefined,
          closed,
        );
        if (!result || typeof result !== "object" || !("render" in result) || !("handleInput" in result)) {
          throw new Error("Running agents menu did not return an interactive component");
        }
        component = result as Component;
      },
    },
  });
  await showRunningAgentsMenu(ctx);
  if (!component) throw new Error("Running agents menu did not open");
  const menu = component;
  return {
    closed,
    press(...keys: string[]) {
      for (const key of keys) menu.handleInput!(key);
    },
    selection() {
      return menu
        .render(WIDTH)
        .find((line) => line.startsWith("→ "))
        ?.slice(2)
        .trim();
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const stopped = makeFinishedAgent("agent-2", { type: "stopped-agent" });
  stopped.lifecycle.status = "stopped";
  mockModules.mockManager.listAgents
    .mockReset()
    .mockReturnValue([
      makeRunningAgent("agent-1", { type: "running-agent" }),
      stopped,
      makeFinishedAgent("agent-3", { type: "completed-agent" }),
    ]);
});

afterEach(resetConfig);

describe("running agents keyboard navigation", () => {
  it("visits every selectable row in order, skipping separators on repeated sweeps", async () => {
    const menu = await openMenu();
    const cycle = [
      "running-agent",
      "stopped-agent",
      "completed-agent",
      "Stop 1 running agent(s)",
      "Clear done",
      "Clear all",
    ];
    for (let pass = 0; pass < 3; pass++) {
      for (const label of cycle) {
        expect(menu.selection()).toContain(label);
        menu.press(DOWN);
      }
    }
    expect(menu.selection()).toContain("running-agent");
  });

  it.each([
    ["down from the last agent to the first bulk action", [DOWN, DOWN, DOWN], "Stop 1 running agent(s)"],
    ["up from the bulk actions to the last agent", [DOWN, DOWN, DOWN, UP], "completed-agent"],
    ["up from the first agent to the last bulk action", [UP], "Clear all"],
    ["down from the last bulk action to the first agent", [UP, DOWN], "running-agent"],
  ])("moves %s", async (_name, keys, expected) => {
    const menu = await openMenu();
    menu.press(...keys);
    expect(menu.selection()).toContain(expected);
  });

  it("executes the bulk action reached past a separator", async () => {
    const menu = await openMenu();
    menu.press(DOWN, DOWN, DOWN, ENTER);
    expect(mockModules.mockManager.abort.mock.calls).toEqual([["agent-1", "user"]]);
    expect(menu.closed).toHaveBeenCalledOnce();
  });
});
