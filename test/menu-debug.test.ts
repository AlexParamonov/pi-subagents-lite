/**
 * menu-debug.test.ts — Tests for showDebugMenu.
 *
 * Tests are covered via the dispatcher tests in menus.test.ts
 * (handleAgentBriefing — worktree_path content)
 *
 * This file exists for structural completeness; individual debug menu
 * tests live in menus.test.ts since they test via showAgentsMainMenu.
 */

import { describe, it } from "vitest";

describe("menu-debug", () => {
  it("is tested via dispatcher integration tests in menus.test.ts", () => {
    // All debug menu tests exercise through showAgentsMainMenu → Debug
    // See: handleAgentBriefing — worktree_path content
  });
});
