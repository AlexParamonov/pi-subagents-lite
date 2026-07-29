/** Diagnostics menu tests. */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import { getAllTypes, getAgentConfig } from "../../../src/agents/agent-types.js";

let selectLists: Array<any> = [];
vi.mock("@earendil-works/pi-tui", () => ({
  SelectList: class MockSelectList {
    items: any[];
    onSelect?: (item: any) => void;
    constructor(items: any[]) { this.items = items; selectLists.push(this); }
    render() { return []; }
    handleInput() {}
  },
}));
vi.mock("../../../src/ui/menu/wrappers/settings-list.js", () => ({
  SettingsListWrapper: class MockSettingsListWrapper {
    constructor(_component: any, _options: any) {}
    render() { return []; }
    handleInput() {}
  },
}));

import { showDiagnosticsMenu } from "../../../src/ui/menu/menu-debug.js";

describe("showDiagnosticsMenu", () => {
  beforeEach(() => {
    selectLists = [];
    vi.clearAllMocks();
    (getAllTypes as any).mockReturnValue([]);
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("only exposes agent types and never sends a briefing", async () => {
    const ctx = createMockCtx();
    await showDiagnosticsMenu(ctx);
    expect(selectLists[0].items).toEqual([
      expect.objectContaining({ value: "agent-types", label: "Agent types" }),
    ]);
    expect(mockModules.mockPiInstance.sendUserMessage).not.toHaveBeenCalled();
  });

  it("reports when no agent types are available", async () => {
    const ctx = createMockCtx();
    await showDiagnosticsMenu(ctx);
    await selectLists[0].onSelect!({ value: "agent-types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith("No agent types available", "info");
  });

  it("lists configured agent metadata", async () => {
    (getAllTypes as any).mockReturnValue(["Explore"]);
    (getAgentConfig as any).mockReturnValue({
      description: "Search the codebase",
      hidden: true,
      model: "openai/gpt-4o",
      registeredTools: ["read", "bash"],
      source: ".pi/agents/explore.md",
    });
    const ctx = createMockCtx();
    await showDiagnosticsMenu(ctx);
    await selectLists[0].onSelect!({ value: "agent-types" });
    const message = ctx.ui.notify.mock.calls[0][0];
    expect(message).toContain("Explore [HIDDEN]");
    expect(message).toContain("Search the codebase");
    expect(message).toContain("Model: openai/gpt-4o");
    expect(message).toContain("Tools: read, bash");
    expect(message).toContain("Source: .pi/agents/explore.md");
  });

  it("shows the built-in-tools fallback", async () => {
    (getAllTypes as any).mockReturnValue(["Explore"]);
    (getAgentConfig as any).mockReturnValue({ description: "Search" });
    const ctx = createMockCtx();
    await showDiagnosticsMenu(ctx);
    await selectLists[0].onSelect!({ value: "agent-types" });
    expect(ctx.ui.notify.mock.calls[0][0]).toContain("Tools: all built-in tools");
  });
});
