/** Real SDK contract tests; also run against the host Pi with PI_SUBAGENTS_TEST_PI_DIR. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { loadPiBuiltinExtensions } from "../../src/agents/pi-builtins.js";
import { resolveSessionToolOptions } from "../../src/agents/agent-types.js";
import { disposeAgentSession } from "../../src/agents/session-disposal.js";

const Pi: typeof import("@earendil-works/pi-coding-agent") = process.env.PI_SUBAGENTS_TEST_PI_DIR
  ? await import(pathToFileURL(join(process.env.PI_SUBAGENTS_TEST_PI_DIR, "dist", "index.js")).href)
  : await import("@earendil-works/pi-coding-agent");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function workspace(defaultTools?: string[], projectDefaultTools?: string[], extensions?: string[]) {
  const root = mkdtempSync(join(tmpdir(), "pi-subagent-defaults-"));
  directories.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools, extensions }));
  writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultTools: projectDefaultTools }));
  return { cwd, agentDir };
}

async function compareSessions(defaultTools?: string[], projectDefaultTools?: string[], extensions?: string[]) {
  const { cwd, agentDir } = workspace(defaultTools, projectDefaultTools, extensions);
  const builtinExtensions = await loadPiBuiltinExtensions(Pi.getPackageDir());
  const sessions: Awaited<ReturnType<typeof Pi.createAgentSession>>["session"][] = [];
  let liveResources = 0;
  try {
    for (const child of [false, true]) {
      const settingsManager = Pi.SettingsManager.create(cwd, agentDir);
      const resourceLoader = new Pi.DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          ...builtinExtensions,
          (pi) => {
            pi.on("session_start", async () => {
              liveResources++;
              pi.registerTool({ ...tool, name: "late_fixture" });
            });
            pi.on("session_shutdown", async () => {
              liveResources--;
            });
            // Arbitrary registered inactive tool, not a built-in special case.
            const tool = {
              name: "aasdfasdf",
              label: "Default-tools fixture",
              description: "Fixture",
              defaultActive: false,
              parameters: Type.Object({}),
              execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined }),
            };
            pi.registerTool(tool);
            // This backing tool must remain registered even when not declared.
            const deferred = { ...tool, name: "deferred_fixture", exposure: "deferred" as const };
            pi.registerTool(deferred);
          },
        ],
      });
      await resourceLoader.reload();
      expect(resourceLoader.getExtensions().errors).toEqual([]);
      const options = child ? resolveSessionToolOptions({ defaultTools: settingsManager.getDefaultTools() }) : {};
      const { session } = await Pi.createAgentSession({
        cwd,
        agentDir,
        settingsManager,
        resourceLoader,
        sessionManager: Pi.SessionManager.inMemory(cwd),
        ...options,
      });
      sessions.push(session);
      await session.bindExtensions({});
    }
    const [main, child] = sessions;
    expect(child.getActiveToolNames()).toEqual(main.getActiveToolNames());
    expect(child.getAllTools().map((tool) => tool.name)).toEqual(main.getAllTools().map((tool) => tool.name));
    expect(child.getAllTools().some((tool) => tool.name === "deferred_fixture")).toBe(true);
    // Assert implementation availability, not just equality of two missing tool sets.
    if (extensions?.includes("-builtin:codemode")) {
      expect(child.getAllTools().some((tool) => tool.name === "codemode")).toBe(false);
    } else if (
      builtinExtensions.some((extension) => typeof extension !== "function" && extension.name === "codemode")
    ) {
      if (child.settingsManager.getDefaultTools()?.includes("codemode")) {
        expect(child.getActiveToolNames()).toContain("codemode");
        const tool = child.agent.state.tools.find((tool) => tool.name === "codemode")!;
        const args = { code: "return await tools.deferred_fixture({});" };
        // Supply the assistant-call context required by Pi's nested-call pipeline,
        // without making an external model request.
        child.agent.state.messages.push({
          role: "assistant",
          content: [{ type: "toolCall", id: "defaults-probe", name: "codemode", arguments: args }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "fixture",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: Date.now(),
        });
        const result = await tool.execute("defaults-probe", args);
        expect(JSON.stringify(result.content)).toContain("Script completed");
        expect(JSON.stringify(result.content)).toContain("ok");
      }
    }
  } finally {
    for (const session of sessions) await disposeAgentSession(session);
    expect(liveResources).toBe(0);
  }
}

describe("child sessions use Pi's defaults and complete built-in extension registry", () => {
  it.each([
    { name: "unconfigured defaults", tools: undefined },
    { name: "empty defaults", tools: [] },
    { name: "arbitrary tool", tools: ["aasdfasdf"] },
    { name: "arbitrary modifier", tools: ["+aasdfasdf"] },
    { name: "late-registered tool", tools: ["late_fixture"] },
    { name: "built-in extension modifier", tools: ["+codemode"] },
    { name: "unknown tool", tools: ["unregistered_fixture"] },
  ])("$name matches a normal Pi session", async ({ tools }) => {
    await compareSessions(tools);
  });

  it("preserves project-over-global modifier semantics", async () => {
    await compareSessions(["read", "aasdfasdf"], ["-read", "+codemode"]);
  });

  it("honors settings that disable a built-in extension", async ({ skip }) => {
    const registry = await loadPiBuiltinExtensions(Pi.getPackageDir());
    if (!registry.some((extension) => typeof extension !== "function" && "builtin" in extension)) skip();
    await compareSessions(["+codemode"], undefined, ["-builtin:codemode"]);
  });

  it("keeps explicit agent restrictions and the no-sub-subagent policy", () => {
    expect(resolveSessionToolOptions({ tools: ["read"], defaultTools: ["aasdfasdf"] })).toEqual({
      tools: ["read"],
      excludeTools: ["Agent"],
    });
    expect(resolveSessionToolOptions({ tools: false })).toEqual({ tools: [], excludeTools: ["Agent"] });
    expect(resolveSessionToolOptions({ registeredTools: ["read", "grep"] })).toEqual({
      tools: ["read", "grep"],
      excludeTools: ["Agent"],
    });
    expect(resolveSessionToolOptions({ defaultTools: ["aasdfasdf"] })).toEqual({ excludeTools: ["Agent"] });
    expect(resolveSessionToolOptions({ excludeTools: ["later_registered_tool"] })).toEqual({
      excludeTools: ["Agent", "later_registered_tool"],
    });
  });
});
