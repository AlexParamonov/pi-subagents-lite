import { describe, expect, it, vi } from "vite-plus/test";
import { fakeCtx } from "../fixtures.js";
import { asExtensionAPI } from "../pi-boundaries.js";
import { getSubagentParent, withSubagentParent } from "../../src/agents/subagent-context.js";

describe("subagent parent context", () => {
  it("is visible after the extension module is reloaded and clears after the scope", async () => {
    const parent = { pi: asExtensionAPI({}), ctx: fakeCtx() };

    await withSubagentParent(parent, async () => {
      vi.resetModules();
      const reloadedModule = await import("../../src/agents/subagent-context.js");
      expect(reloadedModule.getSubagentParent()).toBe(parent);
    });

    expect(getSubagentParent()).toBeUndefined();
  });
});
