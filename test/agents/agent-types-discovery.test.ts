/**
 * agent-types-discovery.test.ts — Parent and worktree agent discovery.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { makeAgentMd, tempDirWithFiles } from "../fixtures.ts";
import {
  registerAgents,
  setAgentScanDirs,
  discoverNewAgents,
  resolveType,
  getAgentConfig,
  resolveWorktreeAgent,
  resolveAgentCatalog,
  resolveTypeInCatalog,
} from "../../src/agents/agent-types.js";

describe("worktree-local agent resolution", () => {
  beforeEach(() => {
    registerAgents(new Map(), { disableDefaultAgents: true });
    setAgentScanDirs("", "", "");
  });

  it("keeps parallel A/B overlays atomic and leaves the parent registry unchanged", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([
      { name: "reviewer.md", content: makeAgentMd({
        name: "reviewer", description: "Parent reviewer", tools: "read",
      }).replace("System prompt body text.", "Parent prompt.") },
    ], "parent-agents");
    const { dir: worktreeA, cleanup: cleanupA } = tempDirWithFiles([
      { name: "reviewer.md", content: makeAgentMd({
        name: "reviewer", description: "A reviewer", tools: "bash",
      }).replace("System prompt body text.", "A prompt.") },
    ], "worktree-a-agents");
    const { dir: worktreeB, cleanup: cleanupB } = tempDirWithFiles([
      { name: "reviewer.md", content: makeAgentMd({
        name: "reviewer", description: "B reviewer", tools: "write",
      }).replace("System prompt body text.", "B prompt.") },
    ], "worktree-b-agents");

    try {
      setAgentScanDirs("", projectDir);
      await discoverNewAgents({ disableDefaultAgents: true });

      const [a, b] = await Promise.all([
        resolveWorktreeAgent("reviewer", worktreeA, { disableDefaultAgents: true }),
        resolveWorktreeAgent("reviewer", worktreeB, { disableDefaultAgents: true }),
      ]);

      expect(a).toMatchObject({ type: "reviewer", config: {
        description: "A reviewer", systemPrompt: "A prompt.",
        registeredTools: ["bash"], tools: ["bash"],
      } });
      expect(b).toMatchObject({ type: "reviewer", config: {
        description: "B reviewer", systemPrompt: "B prompt.",
        registeredTools: ["write"], tools: ["write"],
      } });
      expect(getAgentConfig("reviewer")).toMatchObject({
        description: "Parent reviewer", systemPrompt: "Parent prompt.",
        registeredTools: ["read"], tools: ["read"],
      });

      // A later parent refresh still sees only parent definitions.
      await discoverNewAgents({ disableDefaultAgents: true });
      expect(getAgentConfig("reviewer")?.description).toBe("Parent reviewer");
    } finally {
      cleanupProject();
      cleanupA();
      cleanupB();
    }
  });

  it("resolves worktree-only types locally without registering them globally", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: worktreeDir, cleanup: cleanupWt } = tempDirWithFiles([
      { name: "feature-reviewer.md", content: makeAgentMd({ name: "feature-reviewer", description: "Worktree only" }) },
    ], "worktree-agents");
    try {
      setAgentScanDirs("", projectDir);
      const resolved = await resolveWorktreeAgent("feature-reviewer", worktreeDir, { disableDefaultAgents: true });
      expect(resolved?.config.description).toBe("Worktree only");
      expect(resolveType("feature-reviewer")).toBeUndefined();
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("exposes the same isolated worktree overlay through invocation catalogs", async () => {
    const { dir: worktreeDir, cleanup } = tempDirWithFiles([
      { name: "only.md", content: makeAgentMd({ name: "catalog-only", description: "Catalog only" }) },
    ], "catalog-agents");
    try {
      const catalog = await resolveAgentCatalog(worktreeDir, { disableDefaultAgents: true });
      expect(resolveTypeInCatalog(catalog, "catalog-only")).toBe("catalog-only");
      expect(catalog.get("catalog-only")?.description).toBe("Catalog only");
      expect(resolveType("catalog-only")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("refreshes the global registry for a non-worktree discovery", async () => {
    const { dir: projectDir, cleanup } = tempDirWithFiles([
      { name: "parent.md", content: makeAgentMd({ name: "parent", description: "Parent" }) },
    ], "project-agents");
    try {
      setAgentScanDirs("", projectDir);
      expect(await discoverNewAgents({ disableDefaultAgents: true })).toBe(1);
      expect(getAgentConfig("parent")?.description).toBe("Parent");
    } finally {
      cleanup();
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
    const { dir: sharedDir, cleanup: cleanupShared } = tempDirWithFiles([
      { name: "shared-agent.md", content: makeAgentMd({ name: "shared-agent", description: "Shared workspace agent" }) },
    ], "shared-agents");

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
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([
      { name: "clash.md", content: makeAgentMd({ name: "clash", description: "From project" }) },
    ], "project-agents");
    const { dir: sharedDir, cleanup: cleanupShared } = tempDirWithFiles([
      { name: "clash.md", content: makeAgentMd({ name: "clash", description: "From shared" }) },
    ], "shared-agents");

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
    const { dir: userDir, cleanup: cleanupUser } = tempDirWithFiles([
      { name: "clash.md", content: makeAgentMd({ name: "clash", description: "From user" }) },
    ], "user-agents");
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: sharedDir, cleanup: cleanupShared } = tempDirWithFiles([
      { name: "clash.md", content: makeAgentMd({ name: "clash", description: "From shared" }) },
    ], "shared-agents");

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
    const { dir: sharedDir, cleanup: cleanupShared } = tempDirWithFiles([
      { name: "shared-agent.md", content: makeAgentMd({ name: "shared-agent", description: "Shared" }) },
    ], "shared-agents");

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
    const { dir: userDir, cleanup: cleanupUser } = tempDirWithFiles([
      { name: "layered.md", content: makeAgentMd({ name: "layered", description: "From user", model: "model/user" }) },
    ], "user-agents");
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([
      { name: "layered.md", content: makeAgentMd({ name: "layered", description: "From project", _skip: ["model"] }) },
    ], "project-agents");
    const { dir: sharedDir, cleanup: cleanupShared } = tempDirWithFiles([
      { name: "layered.md", content: makeAgentMd({ name: "layered", description: "From shared", model: "model/shared" }) },
    ], "shared-agents");

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

