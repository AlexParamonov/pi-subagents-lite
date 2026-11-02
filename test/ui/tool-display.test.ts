/**
 * tool-display.test.ts — The viewer's link to pi's global tool-output flag.
 */
import { describe, it, expect, vi } from "vite-plus/test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const notifyToolsExpanded = vi.fn<(expanded: boolean) => void>();
vi.mock("../../src/shell.js", () => ({
  getStore: () => ({ notifyToolsExpanded }),
}));

import { toolExpansionControls } from "../../src/ui/tool-display.js";

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

describe("toolExpansionControls", () => {
  it("reads pi's flag live", () => {
    const { ctx } = makeCtx(false);
    const controls = toolExpansionControls(ctx);
    expect(controls.isExpanded?.()).toBe(false);
    controls.toggleExpanded?.();
    expect(controls.isExpanded?.()).toBe(true);
  });

  it("toggles through pi's setter and syncs the widget compact mode", () => {
    const { ui, ctx } = makeCtx(true);

    toolExpansionControls(ctx).toggleExpanded?.();

    expect(ui.setToolsExpanded).toHaveBeenCalledWith(false);
    expect(notifyToolsExpanded).toHaveBeenCalledWith(false);
  });
});
