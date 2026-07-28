/** Filesystem-backed catalog isolation tests. */
import { describe, it, expect, beforeEach } from "vitest";
import { makeAgentMd, tempDirWithFiles } from "../fixtures.ts";
import { registerAgents, setAgentScanDirs, discoverNewAgents, resolveAgentCatalog, resolveType, resolveTypeInCatalog, getAgentConfig } from "../../src/agents/agent-types.js";

describe("worktree invocation catalogs", () => {
  beforeEach(() => { registerAgents(new Map(), { disableDefaultAgents: true }); setAgentScanDirs("", "", ""); });
  it("overrides same-name base definitions without mutating the parent registry", async () => {
    const { dir: parent, cleanup: cleanParent } = tempDirWithFiles([{ name: "review.md", content: makeAgentMd({ name: "review", description: "parent" }) }], "parent-agents");
    const { dir: worktree, cleanup: cleanWorktree } = tempDirWithFiles([{ name: "review.md", content: makeAgentMd({ name: "review", description: "worktree" }) }], "worktree-agents");
    try { setAgentScanDirs("", parent); await discoverNewAgents({ disableDefaultAgents: true }); const catalog = await resolveAgentCatalog(worktree, { disableDefaultAgents: true }); expect(catalog.get("review")?.description).toBe("worktree"); expect(getAgentConfig("review")?.description).toBe("parent"); } finally { cleanParent(); cleanWorktree(); }
  });
  it("keeps a unique worktree type out of the shared registry", async () => {
    const { dir: worktree, cleanup } = tempDirWithFiles([{ name: "only.md", content: makeAgentMd({ name: "worktree-only", thinking: "high", max_turns: "50" }) }], "worktree-agents");
    try { const catalog = await resolveAgentCatalog(worktree, { disableDefaultAgents: true }); expect(resolveTypeInCatalog(catalog, "worktree-only")).toBe("worktree-only"); expect(catalog.get("worktree-only")?.thinkingLevel).toBe("high"); expect(resolveType("worktree-only")).toBeUndefined(); } finally { cleanup(); }
  });
  it("switching or cancelling local catalogs cannot leak types", async () => {
    const { dir: a, cleanup: cleanA } = tempDirWithFiles([{ name: "a.md", content: makeAgentMd({ name: "a-only" }) }], "a"); const { dir: b, cleanup: cleanB } = tempDirWithFiles([{ name: "b.md", content: makeAgentMd({ name: "b-only" }) }], "b");
    try { const catalogA = await resolveAgentCatalog(a, { disableDefaultAgents: true }); const catalogB = await resolveAgentCatalog(b, { disableDefaultAgents: true }); expect(catalogA.has("a-only")).toBe(true); expect(catalogB.has("a-only")).toBe(false); expect(resolveType("a-only")).toBeUndefined(); expect(resolveType("b-only")).toBeUndefined(); } finally { cleanA(); cleanB(); }
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

