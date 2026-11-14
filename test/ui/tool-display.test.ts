/**
 * tool-display.test.ts — The viewer's link to pi's global tool-output flag.
 */
import { describe, it, expect, vi } from "vite-plus/test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const notifyToolsExpanded = vi.fn<(expanded: boolean) => void>();
vi.mock("../../src/shell.js", () => ({
  getStore: () => ({ notifyToolsExpanded }),
}));

import { viewerToolDisplay } from "../../src/ui/tool-display.js";
import type { AgentManager } from "../../src/agents/agent-manager.js";

function makeCtx(initial: boolean) {
  let expanded = initial;
  const ui = {
    getToolsExpanded: vi.fn(() => expanded),
    setToolsExpanded: vi.fn((v: boolean) => {
      expanded = v;
    }),
  };
  return { ui, ctx: { ui } as unknown as Pick<ExtensionContext, "ui"> };
}

/** Manager stub: only the tool-start lookup the viewer asks for. */
function makeManager(starts: Record<string, number> = {}) {
  return {
    getToolStartedAt: vi.fn((agentId: string, toolCallId: string) =>
      agentId === "a1" ? starts[toolCallId] : undefined,
    ),
  } as unknown as AgentManager;
}

describe("viewerToolDisplay", () => {
  it("follows pi's tool-output flag, and tells the widgets when it flips", () => {
    const { ui, ctx } = makeCtx(true);
    const display = viewerToolDisplay(ctx, makeManager(), "a1");

    expect(display.isExpanded?.()).toBe(true);
    display.toggleExpanded?.();
    expect(display.isExpanded?.()).toBe(false); // read live, not snapshotted at construction
    expect(ui.setToolsExpanded).toHaveBeenCalledWith(false); // pi's own setter, so the menu follows
    expect(notifyToolsExpanded).toHaveBeenCalledWith(false);
  });

  it("finds running-call starts for the viewer's own agent, and none without a manager", () => {
    const display = viewerToolDisplay(makeCtx(false).ctx, makeManager({ t1: 1234 }), "a1");

    expect(display.getToolStartedAt?.("t1")).toBe(1234);
    expect(display.getToolStartedAt?.("other")).toBeUndefined();
    expect(viewerToolDisplay(makeCtx(false).ctx, undefined, "a1").getToolStartedAt?.("t1")).toBeUndefined();
  });
});
