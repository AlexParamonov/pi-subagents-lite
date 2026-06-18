/**
 * worktree-schema-briefing.test.ts — Acceptance tests for worktree_path in
 * the Agent tool schema and the agent briefing.
 *
 * Covers:
 *   - worktree_path parameter is present in the Agent tool schema
 *   - worktree_path has no .description() (stealth-tool convention)
 *
 * Briefing content is tested in menu-debug.test.ts (worktree_path usage guidelines, agent type headings, etc.).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createMockExtensionAPI,
  hasParam,
  loadExtension,
  type MockExtensionAPI,
} from "../fixtures.ts";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/**
 * Load the extension and find the Agent tool registration.
 */
async function getAgentToolReg(api: MockExtensionAPI) {
  await loadExtension(api.api);
  const agentTool = api.tools.find((t) => t.name === "Agent");
  expect(agentTool).toBeDefined();
  return agentTool!;
}

/* ------------------------------------------------------------------ */
/*  Schema tests                                                      */
/* ------------------------------------------------------------------ */

describe("Agent tool schema — worktree_path", () => {
  let api: MockExtensionAPI;

  beforeEach(() => {
    api = createMockExtensionAPI();
  });

  it("has worktree_path parameter in the Agent tool schema", async () => {
    const tool = await getAgentToolReg(api);
    expect(hasParam(tool.parameters, "worktree_path")).toBe(true);
  });

  it("worktree_path is optional in the schema", async () => {
    const tool = await getAgentToolReg(api);
    // TypeBox optional properties are wrapped in { ... } with no 'required' array
    // containing the field — or the field is in the schema but not in 'required'
    const schema = tool.parameters;
    const required = schema.required ?? [];
    expect(required).not.toContain("worktree_path");
  });

  it("worktree_path is a string type in the schema", async () => {
    const tool = await getAgentToolReg(api);
    const prop = tool.parameters.properties?.worktree_path;
    expect(prop).toBeDefined();
    // TypeBox string type: { type: "string" } or { type: "string", ... }
    expect(prop.type).toBe("string");
  });

  it("worktree_path has no description (stealth-tool convention)", async () => {
    const tool = await getAgentToolReg(api);
    const prop = tool.parameters.properties?.worktree_path;
    expect(prop.description).toBeUndefined();
  });
});
