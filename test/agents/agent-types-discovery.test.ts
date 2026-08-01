/**
 * worktree-discovery.test.ts — Tests for worktree-local agent type discovery.
 *
 * Verifies:
 *   - discoverNewAgents scans the worktree's .pi/agents/ when worktreeDir is set
 *   - Worktree-local types are discovered and added to the session-wide registry
 *   - Worktree scan does not interfere with existing parent/global discovery
 *   - Missing or non-existent worktree .pi/agents/ dir is handled gracefully
 *   - Worktree-local type fails to resolve without worktreeDir (not in parent/global)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { makeAgentMd, tempDirWithFiles } from "../fixtures.ts";
import {
  registerAgents,
  setAgentScanDirs,
  discoverNewAgents,
  resolveType,
  getAgentConfig,
} from "../../src/agents/agent-types.js";
import { DEFAULT_AGENTS } from "../../src/agents/default-agents.js";

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("discoverNewAgents — worktree-local agent types", () => {
  beforeEach(() => {
    // Reset to clean state: just the default agents
    registerAgents(new Map());
    // Clear scan dirs so they don't pollute tests
    setAgentScanDirs("", "");
  });

  it("discovers a worktree-local agent type when worktreeDir is set", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: worktreeDir, cleanup: cleanupWt } = tempDirWithFiles(
      [
        {
          name: "feature-reviewer.md",
          content: makeAgentMd({ name: "feature-reviewer", description: "Reviews feature branches" }),
        },
      ],
      "worktree-agents",
    );

    try {
      setAgentScanDirs("", projectDir);
      registerAgents(new Map());

      // Not known before discovery
      expect(resolveType("feature-reviewer")).toBeUndefined();

      // Discover with worktree dir
      const count = await discoverNewAgents(worktreeDir);
      expect(count).toBeGreaterThanOrEqual(1);

      // Now it should be resolved
      expect(resolveType("feature-reviewer")).toBe("feature-reviewer");
      expect(getAgentConfig("feature-reviewer")?.description).toBe("Reviews feature branches");
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("worktree-local type is NOT found without worktreeDir", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: worktreeDir, cleanup: cleanupWt } = tempDirWithFiles(
      [{ name: "feature-reviewer.md", content: makeAgentMd({ name: "feature-reviewer" }) }],
      "worktree-agents",
    );

    try {
      setAgentScanDirs("", projectDir);
      registerAgents(new Map());

      // Discover WITHOUT worktree dir — should not find the worktree type
      await discoverNewAgents();
      expect(resolveType("feature-reviewer")).toBeUndefined();
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("worktree scan adds to session-wide registry, visible to subsequent spawns", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: worktreeDir, cleanup: cleanupWt } = tempDirWithFiles(
      [{ name: "wt-agent.md", content: makeAgentMd({ name: "wt-agent", description: "WT agent" }) }],
      "worktree-agents",
    );

    try {
      setAgentScanDirs("", projectDir);
      registerAgents(new Map());

      // First discovery with worktree
      await discoverNewAgents(worktreeDir);
      expect(resolveType("wt-agent")).toBe("wt-agent");

      // Second discovery WITHOUT worktree — should still be in registry
      const count = await discoverNewAgents();
      expect(resolveType("wt-agent")).toBe("wt-agent");
      expect(count).toBe(0); // No new agents (already known)
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("worktree scan does not interfere with existing parent/global discovery", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles(
      [{ name: "project-agent.md", content: makeAgentMd({ name: "project-agent", description: "Project" }) }],
      "project-agents",
    );
    const { dir: worktreeDir, cleanup: cleanupWt } = tempDirWithFiles(
      [{ name: "wt-agent.md", content: makeAgentMd({ name: "wt-agent", description: "WT" }) }],
      "worktree-agents",
    );

    try {
      setAgentScanDirs("", projectDir);
      registerAgents(new Map());

      const count = await discoverNewAgents(worktreeDir);

      // Both project and worktree types should be discovered
      expect(resolveType("project-agent")).toBe("project-agent");
      expect(resolveType("wt-agent")).toBe("wt-agent");
      expect(count).toBeGreaterThanOrEqual(2);
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("handles missing worktree .pi/agents/ directory gracefully (no error)", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: nonexistentDir, cleanup: cleanupNonexistent } = tempDirWithFiles([], "nonexistent-base");

    try {
      setAgentScanDirs("", projectDir);
      registerAgents(new Map());

      // Point to a directory that doesn't have .pi/agents/ — should not error
      const fakeWorktreeDir = nonexistentDir + "/.pi/agents";
      const count = await discoverNewAgents(fakeWorktreeDir);
      expect(count).toBe(0);
    } finally {
      cleanupProject();
      cleanupNonexistent();
    }
  });

  it("uses the same parsing rules as the parent scan (frontmatter format, name field)", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: worktreeDir, cleanup: cleanupWt } = tempDirWithFiles(
      [
        {
          name: "wt-agent.md",
          content: makeAgentMd({ name: "wt-agent", extensions: "read, bash", thinking: "high", max_turns: "50" }),
        },
      ],
      "worktree-agents",
    );

    try {
      setAgentScanDirs("", projectDir);
      registerAgents(new Map());

      await discoverNewAgents(worktreeDir);
      const config = getAgentConfig("wt-agent");
      expect(config).toBeDefined();
      // Extensions parsed correctly
      expect(config!.extensions).toEqual(["read", "bash"]);
      // Thinking parsed correctly
      expect(config!.thinkingLevel).toBe("high");
      // Max turns parsed correctly
      expect(config!.maxTurns).toBe(50);
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("parses thinking level max from frontmatter", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: worktreeDir, cleanup: cleanupWt } = tempDirWithFiles(
      [{ name: "max-thinker.md", content: makeAgentMd({ name: "max-thinker", thinking: "max" }) }],
      "worktree-agents",
    );

    try {
      setAgentScanDirs("", projectDir);
      registerAgents(new Map());

      await discoverNewAgents(worktreeDir);
      const config = getAgentConfig("max-thinker");
      expect(config).toBeDefined();
      expect(config!.thinkingLevel).toBe("max");
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("returns 0 when worktreeDir is empty string (treated as omitted)", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: worktreeDir, cleanup: cleanupWt } = tempDirWithFiles(
      [{ name: "wt-agent.md", content: makeAgentMd({ name: "wt-agent" }) }],
      "worktree-agents",
    );

    try {
      setAgentScanDirs("", projectDir);
      registerAgents(new Map());

      const count = await discoverNewAgents("");
      expect(count).toBe(0);
      expect(resolveType("wt-agent")).toBeUndefined();
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("does not duplicate agents already in the registry", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles(
      [{ name: "shared.md", content: makeAgentMd({ name: "shared", description: "From project" }) }],
      "project-agents",
    );
    const { dir: worktreeDir, cleanup: cleanupWt } = tempDirWithFiles(
      [{ name: "wt-shared.md", content: makeAgentMd({ name: "shared", description: "From worktree" }) }],
      "worktree-agents",
    );

    try {
      setAgentScanDirs("", projectDir);
      registerAgents(new Map());

      // First discovery — project agent gets added
      await discoverNewAgents();
      expect(getAgentConfig("shared")?.description).toBe("From project");

      // Second discovery with worktree — should NOT override the already-registered agent
      const count = await discoverNewAgents(worktreeDir);
      expect(count).toBe(0); // "shared" is already known
      expect(getAgentConfig("shared")?.description).toBe("From project");
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });
});

describe("discoverNewAgents — shared .agents/agents/ discovery", () => {
  beforeEach(() => {
    registerAgents(new Map());
    setAgentScanDirs("", "", "");
  });

  it("discovers agents from .agents/agents/ directory", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: sharedDir, cleanup: cleanupShared } = tempDirWithFiles(
      [
        {
          name: "shared-agent.md",
          content: makeAgentMd({ name: "shared-agent", description: "Shared workspace agent" }),
        },
      ],
      "shared-agents",
    );

    try {
      setAgentScanDirs("", projectDir, sharedDir);
      registerAgents(new Map());

      expect(resolveType("shared-agent")).toBeUndefined();

      const count = await discoverNewAgents();
      expect(count).toBeGreaterThanOrEqual(1);

      expect(resolveType("shared-agent")).toBe("shared-agent");
      expect(getAgentConfig("shared-agent")?.description).toBe("Shared workspace agent");
    } finally {
      cleanupProject();
      cleanupShared();
    }
  });

  it("project agents override shared agents on name clash", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles(
      [{ name: "clash.md", content: makeAgentMd({ name: "clash", description: "From project" }) }],
      "project-agents",
    );
    const { dir: sharedDir, cleanup: cleanupShared } = tempDirWithFiles(
      [{ name: "clash.md", content: makeAgentMd({ name: "clash", description: "From shared" }) }],
      "shared-agents",
    );

    try {
      setAgentScanDirs("", projectDir, sharedDir);
      registerAgents(new Map());

      await discoverNewAgents();

      expect(getAgentConfig("clash")?.description).toBe("From project");
    } finally {
      cleanupProject();
      cleanupShared();
    }
  });

  it("shared agents override user agents on name clash", async () => {
    const { dir: userDir, cleanup: cleanupUser } = tempDirWithFiles(
      [{ name: "clash.md", content: makeAgentMd({ name: "clash", description: "From user" }) }],
      "user-agents",
    );
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: sharedDir, cleanup: cleanupShared } = tempDirWithFiles(
      [{ name: "clash.md", content: makeAgentMd({ name: "clash", description: "From shared" }) }],
      "shared-agents",
    );

    try {
      setAgentScanDirs(userDir, projectDir, sharedDir);
      registerAgents(new Map());

      await discoverNewAgents();

      expect(getAgentConfig("clash")?.description).toBe("From shared");
    } finally {
      cleanupUser();
      cleanupProject();
      cleanupShared();
    }
  });

  it("shared agents get source 'project'", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: sharedDir, cleanup: cleanupShared } = tempDirWithFiles(
      [{ name: "shared-agent.md", content: makeAgentMd({ name: "shared-agent", description: "Shared" }) }],
      "shared-agents",
    );

    try {
      setAgentScanDirs("", projectDir, sharedDir);
      registerAgents(new Map());

      await discoverNewAgents();

      expect(getAgentConfig("shared-agent")?.source).toBe("project");
    } finally {
      cleanupProject();
      cleanupShared();
    }
  });

  it("silently skips non-existent .agents/agents/ directory", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");

    try {
      setAgentScanDirs("", projectDir, "/tmp/nonexistent-shared-agents-dir");
      registerAgents(new Map());

      const count = await discoverNewAgents();
      expect(count).toBe(0);
    } finally {
      cleanupProject();
    }
  });

  it("full precedence: default < user < shared < project", async () => {
    const { dir: userDir, cleanup: cleanupUser } = tempDirWithFiles(
      [
        {
          name: "layered.md",
          content: makeAgentMd({ name: "layered", description: "From user", model: "model/user" }),
        },
      ],
      "user-agents",
    );
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles(
      [
        {
          name: "layered.md",
          content: makeAgentMd({ name: "layered", description: "From project", _skip: ["model"] }),
        },
      ],
      "project-agents",
    );
    const { dir: sharedDir, cleanup: cleanupShared } = tempDirWithFiles(
      [
        {
          name: "layered.md",
          content: makeAgentMd({ name: "layered", description: "From shared", model: "model/shared" }),
        },
      ],
      "shared-agents",
    );

    try {
      setAgentScanDirs(userDir, projectDir, sharedDir);
      registerAgents(new Map());

      await discoverNewAgents();

      const config = getAgentConfig("layered")!;
      expect(config.description).toBe("From project");
      expect(config.model).toBe("model/shared");
    } finally {
      cleanupUser();
      cleanupProject();
      cleanupShared();
    }
  });
});
