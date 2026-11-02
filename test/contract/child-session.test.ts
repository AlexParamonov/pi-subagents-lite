/**
 * child-session.test.ts — Contract tests: a Subagent without explicit tool
 * overrides behaves like a normal pi session in the same workspace.
 *
 * Drives the real SDK through the production createChildSession seam with only
 * the shell store stubbed; the announcement tests wrap
 * AgentSession.prototype.bindExtensions to mark the instant the SDK's bind is
 * invoked, then delegate to it unchanged and restore it. The reference session
 * is wired the way the pi CLI builds one (pi's own private builtInExtensions
 * registry), so child/reference equality is meaningful, not trivial. The fixture
 * extension pins registry completeness (a deferred tool and a session_start-
 * registered tool) and teardown (its live-resource count returns to zero).
 *
 * Matrix: unconfigured, +name, -name, replacement, project-over-global,
 * settings-level built-in disable, implicit OFF, explicit frontmatter
 * tools/extensions, and the child-lifecycle announcements a Subagent-aware
 * extension receives on the parent's bus.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The only mock: the composition-root shell, whose real ConfigStore reads the
// developer's real config file. Everything below drives real code.
const contractStore = vi.hoisted(() => ({
  agent: {
    systemPromptMode: "replace",
    includeContextFiles: false,
    loadSkillsImplicitly: true,
    loadExtensionsImplicitly: true,
    loadToolsImplicitly: true,
    defaultThinking: undefined,
    graceTurns: 6,
    forceBackground: false,
    showCost: false,
    defaultModel: null,
  },
}));

vi.mock("../../src/shell.js", () => ({
  getStore: () => contractStore,
  getManager: () => undefined,
}));

import {
  AgentSession,
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type EventBus,
} from "@earendil-works/pi-coding-agent";
import { createChildSession } from "../../src/agents/agent-runner.js";
import { registerAgents } from "../../src/agents/agent-types.js";
import { disposeChildSession } from "../../src/agents/session-teardown.js";
import { importPiBuiltInExtensions } from "../agents/pi-builtin-registry.js";
import { asExtensionAPI, asExtensionContext } from "../pi-boundaries.js";
import { defaultSessionManager } from "../mock-utils.js";

/** One observed timeline entry, plus its payload when the line carries one. */
interface Observed {
  event: string;
  data?: unknown;
}

interface Workspace {
  project: string;
  statePath: string;
  timelinePath: string;
  hasProbe: boolean;
  writeGlobalSettings(settings: Record<string, unknown>): void;
  writeProjectSettings(settings: Record<string, unknown>): void;
  writeProbeExtension(): void;
  writeLifecycleProbe(): void;
  probeCount(): number;
  timeline(): string[];
}

/** Every workspace root made so far; all removed in afterAll (PI_CODING_AGENT_DIR is reassigned per workspace). */
const workspaceRoots: string[] = [];

function makeWorkspace(name: string): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `subagents-contract-${name}-`));
  workspaceRoots.push(root);
  const agentDir = path.join(root, "agent");
  const project = path.join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  // pi reads the agent dir per call: point it at this workspace so the global
  // settings layer and pi's built-in/extension settings resolve here. Tests in
  // this file run sequentially, so the last workspace wins.
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const statePath = path.join(root, "probe-state.json");
  const timelinePath = path.join(root, "timeline.log");
  const workspace: Workspace = {
    project,
    statePath,
    timelinePath,
    hasProbe: false,
    writeGlobalSettings(settings) {
      fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
    },
    writeProjectSettings(settings) {
      fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
      fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify(settings));
    },
    writeProbeExtension() {
      const dir = path.join(project, ".pi", "extensions");
      fs.mkdirSync(dir, { recursive: true });
      workspace.hasProbe = true;
      // Deferred tool (callable by dispatchers while inactive), a tool
      // registered during session_start (late registration), and one live
      // resource per bound session (shutdown must release it).
      const source = `
import * as fs from "node:fs";
const statePath = ${JSON.stringify(statePath)};
function readCount() {
  try { return JSON.parse(fs.readFileSync(statePath, "utf-8")).live; } catch { return 0; }
}
function writeCount(n) {
  fs.writeFileSync(statePath, JSON.stringify({ live: n }));
}
const probeSchema = { type: "object", properties: {}, required: [] };
export default function (pi) {
  pi.registerTool({
    name: "probe_deferred",
    label: "Probe deferred",
    description: "Deferred probe tool",
    parameters: probeSchema,
    exposure: "deferred",
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });
  pi.on("session_start", async () => {
    writeCount(readCount() + 1);
    pi.registerTool({
      name: "probe_late",
      label: "Probe late",
      description: "session_start-registered probe tool",
      parameters: probeSchema,
      async execute() {
        return { content: [{ type: "text", text: "ok" }], details: {} };
      },
    });
  });
  pi.on("session_shutdown", async () => {
    writeCount(readCount() - 1);
  });
}
`;
      fs.writeFileSync(path.join(dir, "probe.ts"), source);
    },
    probeCount() {
      try {
        return JSON.parse(fs.readFileSync(statePath, "utf-8")).live;
      } catch {
        return 0;
      }
    },
    /** Appends a marker from inside the child's own extensions, at bind time. */
    writeLifecycleProbe() {
      const dir = path.join(project, ".pi", "extensions");
      fs.mkdirSync(dir, { recursive: true });
      const source = `
import * as fs from "node:fs";
export default function (pi) {
  pi.on("session_start", () => fs.appendFileSync(${JSON.stringify(timelinePath)}, "child:session_start\\n"));
}
`;
      fs.writeFileSync(path.join(dir, "lifecycle-probe.ts"), source);
    },
    timeline() {
      try {
        return fs.readFileSync(timelinePath, "utf-8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
  return workspace;
}

/** Appends one marker line; the write is synchronous, so the timeline order is total. */
function appendMarker(workspace: Workspace, marker: string): void {
  fs.appendFileSync(workspace.timelinePath, `${marker}\n`);
}

/** The spawning-session ctx: the child path reads the parent session id off its session manager. */
function parentCtx(project: string) {
  return asExtensionContext({ cwd: project, hasUI: false, sessionManager: defaultSessionManager() });
}

function stubPi(events?: EventBus) {
  return asExtensionAPI({
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    ...(events ? { events } : {}),
  });
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The production child path: our wrapped built-in factories. */
async function spawnChild(workspace: Workspace): Promise<AgentSession> {
  const { session } = await createChildSession(parentCtx(workspace.project), "general-purpose", {
    pi: stubPi(),
    cwd: workspace.project,
  });
  if (workspace.hasProbe) {
    await until(() => session.getAllTools().some((tool) => tool.name === "probe_late"), "probe_late registration");
  }
  return session;
}

/**
 * pi's inline extension factories, spelled through the loader's own options:
 * pi does not export that type from the package entry.
 */
type InlineExtensions = NonNullable<ConstructorParameters<typeof DefaultResourceLoader>[0]["extensionFactories"]>;

/** A real pi session in this workspace, loaded with these extension factories. */
async function openPiSession(workspace: Workspace, extensionFactories: InlineExtensions): Promise<AgentSession> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(workspace.project, agentDir, { projectTrusted: true });
  const loader = new DefaultResourceLoader({
    cwd: workspace.project,
    agentDir,
    settingsManager,
    extensionFactories,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: workspace.project,
    agentDir,
    sessionManager: SessionManager.inMemory(workspace.project),
    settingsManager,
    resourceLoader: loader,
  });
  await session.bindExtensions({});
  return session;
}

/** A normal pi session, wired the way the CLI wires one (pi's own built-ins). */
async function spawnReference(workspace: Workspace): Promise<AgentSession> {
  const session = await openPiSession(workspace, await importPiBuiltInExtensions<InlineExtensions[number]>());
  if (workspace.hasProbe) {
    await until(() => session.getAllTools().some((tool) => tool.name === "probe_late"), "probe_late registration");
  }
  return session;
}

const registryOf = (session: AgentSession) =>
  session
    .getAllTools()
    .map((tool) => tool.name)
    .sort();
const activeOf = (session: AgentSession) => [...session.getActiveToolNames()].sort();
const callableOf = (session: AgentSession) => [...session.getCallableToolNames()].sort();

beforeAll(() => {
  registerAgents(new Map());
});

afterAll(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  for (const root of workspaceRoots) fs.rmSync(root, { recursive: true, force: true });
});

describe("contract: child extension reload across cwd", () => {
  it("registers only communication tools when the extension reloads for a child cwd", async () => {
    const workspace = makeWorkspace("subagents-child-cwd");
    workspace.writeGlobalSettings({ extensions: [path.resolve("src/index.ts")] });
    const childCwd = path.join(workspace.project, "worktree");
    fs.mkdirSync(childCwd, { recursive: true });

    const { session } = await createChildSession(parentCtx(workspace.project), "general-purpose", {
      pi: stubPi(),
      cwd: childCwd,
    });
    try {
      const tools = registryOf(session);
      expect(tools).toContain("MessageAgent");
      expect(tools).toContain("AgentStatus");
      expect(tools).not.toContain("Agent");
      expect(tools).not.toContain("StopAgent");
    } finally {
      await disposeChildSession(session);
    }
  });
});

describe("contract: child session matches a normal pi session", () => {
  it("with unconfigured defaultTools, registries and active sets are equal", async () => {
    const workspace = makeWorkspace("unconfigured");
    const child = await spawnChild(workspace);
    const reference = await spawnReference(workspace);

    expect(registryOf(child)).toEqual(registryOf(reference));
    expect(activeOf(child)).toEqual(activeOf(reference));
    expect(activeOf(child)).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));

    await disposeChildSession(child);
    await disposeChildSession(reference);
  });

  it("defaultTools ['+codemode'] activates codemode with a complete registry, like a normal session", async () => {
    const workspace = makeWorkspace("plus-codemode");
    workspace.writeGlobalSettings({ defaultTools: ["+codemode"] });
    workspace.writeProbeExtension();
    const child = await spawnChild(workspace);
    const reference = await spawnReference(workspace);

    expect(activeOf(child)).toContain("codemode");
    expect(registryOf(child)).toEqual(registryOf(reference));
    expect(activeOf(child)).toEqual(activeOf(reference));
    // Registry completeness: the deferred probe is callable by dispatchers
    // while inactive, and the session_start-registered tool made it in.
    expect(registryOf(child)).toContain("probe_deferred");
    expect(registryOf(child)).toContain("probe_late");
    expect(callableOf(child)).toContain("probe_deferred");
    expect(activeOf(child)).not.toContain("probe_deferred");
    // Two sessions opened the live resource.
    expect(workspace.probeCount()).toBe(2);

    await disposeChildSession(child);
    expect(workspace.probeCount()).toBe(1);
    await disposeChildSession(reference);
    expect(workspace.probeCount()).toBe(0);
  });

  it("replacement-style defaultTools resolves the same in both sessions", async () => {
    const workspace = makeWorkspace("replacement");
    workspace.writeGlobalSettings({ defaultTools: ["read", "grep"] });
    const child = await spawnChild(workspace);
    const reference = await spawnReference(workspace);

    expect(registryOf(child)).toEqual(registryOf(reference));
    expect(activeOf(child)).toEqual(activeOf(reference));
    expect(activeOf(child)).toEqual(["grep", "read"]);

    await disposeChildSession(child);
    await disposeChildSession(reference);
  });

  it("-name modifiers remove tools in both sessions", async () => {
    const workspace = makeWorkspace("minus-write");
    workspace.writeGlobalSettings({ defaultTools: ["-write"] });
    const child = await spawnChild(workspace);
    const reference = await spawnReference(workspace);

    expect(registryOf(child)).toEqual(registryOf(reference));
    expect(activeOf(child)).toEqual(activeOf(reference));
    expect(activeOf(child)).not.toContain("write");
    expect(activeOf(child)).toContain("read");

    await disposeChildSession(child);
    await disposeChildSession(reference);
  });

  it("project settings override global with modifier semantics preserved", async () => {
    const workspace = makeWorkspace("project-over-global");
    workspace.writeGlobalSettings({ defaultTools: ["+codemode"] });
    workspace.writeProjectSettings({ defaultTools: ["-codemode"] });
    const child = await spawnChild(workspace);
    const reference = await spawnReference(workspace);

    expect(activeOf(child)).toEqual(activeOf(reference));
    expect(activeOf(child)).not.toContain("codemode");
    expect(activeOf(child)).toContain("read");

    await disposeChildSession(child);
    await disposeChildSession(reference);
  });

  it("settings-level built-in disable (-builtin:codemode) keeps codemode out of both registries", async () => {
    const workspace = makeWorkspace("builtin-disable");
    workspace.writeGlobalSettings({ defaultTools: ["+codemode"], extensions: ["-builtin:codemode"] });
    const child = await spawnChild(workspace);
    const reference = await spawnReference(workspace);

    expect(registryOf(child)).toEqual(registryOf(reference));
    expect(registryOf(child)).not.toContain("codemode");

    await disposeChildSession(child);
    await disposeChildSession(reference);
  });
});

describe("contract: implicit OFF and explicit frontmatter", () => {
  it("loadToolsImplicitly OFF with omitted frontmatter tools yields a tool-less child", async () => {
    contractStore.agent.loadToolsImplicitly = false;
    try {
      const workspace = makeWorkspace("implicit-off");
      const child = await spawnChild(workspace);

      expect(registryOf(child)).toEqual([]);
      expect(activeOf(child)).toEqual([]);
    } finally {
      contractStore.agent.loadToolsImplicitly = true;
    }
  });

  it("explicit frontmatter tools gate the registry exactly", async () => {
    registerAgents(
      new Map([
        [
          "contract-explicit",
          { name: "contract-explicit", description: "", systemPrompt: "", tools: ["read", "bash"] },
        ],
      ]),
    );
    const workspace = makeWorkspace("explicit-tools");
    workspace.writeGlobalSettings({ defaultTools: ["+codemode"] });
    const { session } = await createChildSession(parentCtx(workspace.project), "contract-explicit", {
      pi: stubPi(),
      cwd: workspace.project,
    });

    expect(registryOf(session)).toEqual(["bash", "read"]);
    expect(activeOf(session)).toEqual(["bash", "read"]);

    await disposeChildSession(session);
  });

  it("frontmatter extensions: false loads no built-in extensions", async () => {
    registerAgents(
      new Map([["contract-no-ext", { name: "contract-no-ext", description: "", systemPrompt: "", extensions: false }]]),
    );
    const workspace = makeWorkspace("extensions-false");
    workspace.writeGlobalSettings({ defaultTools: ["+codemode"] });
    workspace.writeProbeExtension();
    const { session } = await createChildSession(parentCtx(workspace.project), "contract-no-ext", {
      pi: stubPi(),
      cwd: workspace.project,
    });

    expect(registryOf(session)).not.toContain("codemode");
    // The probe extension is a project extension: extensions: false skips it too.
    expect(registryOf(session)).not.toContain("probe_deferred");
    expect(workspace.probeCount()).toBe(0);

    await disposeChildSession(session);
  });

  it("frontmatter extensions: ['codemode'] selects the built-in by bare name", async () => {
    registerAgents(
      new Map([
        [
          "contract-only-codemode",
          { name: "contract-only-codemode", description: "", systemPrompt: "", extensions: ["codemode"] },
        ],
      ]),
    );
    const workspace = makeWorkspace("only-codemode");
    workspace.writeGlobalSettings({ defaultTools: ["+codemode"] });
    workspace.writeProbeExtension();
    const { session } = await createChildSession(parentCtx(workspace.project), "contract-only-codemode", {
      pi: stubPi(),
      cwd: workspace.project,
    });

    expect(registryOf(session)).toContain("codemode");
    expect(registryOf(session)).not.toContain("probe_deferred");
    // The whitelist excludes the probe extension, so it never loads: the count
    // stays 0 across teardown (teardown-with-loaded-probe is pinned by the
    // +codemode and exclude_extensions cases above).
    expect(workspace.probeCount()).toBe(0);

    await disposeChildSession(session);
    expect(workspace.probeCount()).toBe(0);
  });

  it("frontmatter exclude_extensions: ['codemode'] deselects the built-in by bare name", async () => {
    registerAgents(
      new Map([
        [
          "contract-no-codemode",
          { name: "contract-no-codemode", description: "", systemPrompt: "", excludeExtensions: ["codemode"] },
        ],
      ]),
    );
    const workspace = makeWorkspace("exclude-codemode");
    workspace.writeGlobalSettings({ defaultTools: ["+codemode"] });
    workspace.writeProbeExtension();
    const { session } = await createChildSession(parentCtx(workspace.project), "contract-no-codemode", {
      pi: stubPi(),
      cwd: workspace.project,
    });

    expect(registryOf(session)).not.toContain("codemode");
    expect(registryOf(session)).toContain("probe_deferred");

    await disposeChildSession(session);
    expect(workspace.probeCount()).toBe(0);
  });
});

const CREATED = "subagents:child:session-created";
const BOUND = "subagents:child:bound";
/** Timeline marker for the instant the SDK's own bindExtensions() is invoked. */
const BIND = "child:bindExtensions";
/** Timeline marker for the first microtask after an emit. */
const MICROTASK = "microtask";
/** The parent session id parentCtx()'s session manager reports. */
const PARENT_ID = "session-1";

describe("contract: child session announced on the parent's event bus", () => {
  /**
   * Runs a child spawn with the instant the SDK's own `bindExtensions()` is
   * invoked recorded on the timeline. The real bind still runs untouched, the
   * wrapper only appends a marker, so the subscriber's entries are ordered
   * against the bind call itself and not only against what the bind later emits.
   */
  async function withRecordedBind<T>(workspace: Workspace, spawn: () => Promise<T>): Promise<T> {
    const real = AgentSession.prototype.bindExtensions;
    const recording = function (this: AgentSession, ...args: Parameters<typeof real>) {
      appendMarker(workspace, BIND);
      return real.apply(this, args);
    };
    AgentSession.prototype.bindExtensions = recording;
    try {
      return await spawn();
    } finally {
      AgentSession.prototype.bindExtensions = real;
    }
  }

  /** One timeline for both sides: the bus subscriber and the child's own extension. */
  function observeLifecycle(
    workspace: Workspace,
    options: { marksMicrotask?: boolean } = {},
  ): { events: EventBus; entries: () => Observed[] } {
    const events = createEventBus();
    for (const channel of [CREATED, BOUND]) {
      // Tab-separated: JSON.stringify escapes control characters, so no payload
      // value can produce a second tab. A space would split a payload whose
      // value contains one.
      events.on(channel, (data) => {
        fs.appendFileSync(workspace.timelinePath, `${channel}\t${JSON.stringify(data)}\n`);
        if (options.marksMicrotask && channel === CREATED) {
          queueMicrotask(() => appendMarker(workspace, MICROTASK));
        }
      });
    }
    return {
      events,
      /** Order comes from one file both writers append to synchronously. */
      entries(): Observed[] {
        return workspace.timeline().map((line) => {
          const [event, payload] = line.split("\t");
          return payload ? { event, data: JSON.parse(payload) } : { event };
        });
      },
    };
  }

  it("lands created before the child's bind is invoked, bound after it", async () => {
    const workspace = makeWorkspace("announcements");
    workspace.writeLifecycleProbe();
    const { events, entries } = observeLifecycle(workspace);

    const { session: child } = await withRecordedBind(workspace, () =>
      createChildSession(parentCtx(workspace.project), "general-purpose", {
        pi: stubPi(events),
        cwd: workspace.project,
      }),
    );

    // The child's own session_start handler runs inside the bind, so `bound` is
    // ordered against the bind completing, not merely against it being entered.
    expect(entries()).toEqual([
      { event: CREATED, data: { sessionId: child.sessionId, parentSessionId: PARENT_ID } },
      { event: BIND },
      { event: "child:session_start" },
      { event: BOUND, data: { sessionId: child.sessionId, parentSessionId: PARENT_ID } },
    ]);

    await disposeChildSession(child);
  });

  it("emits created on the bind's own call stack, with no await in between", async () => {
    const workspace = makeWorkspace("announcements-call-stack");
    const { events, entries } = observeLifecycle(workspace, { marksMicrotask: true });

    const { session: child } = await withRecordedBind(workspace, () =>
      createChildSession(parentCtx(workspace.project), "general-purpose", {
        pi: stubPi(events),
        cwd: workspace.project,
      }),
    );

    // The microtask queued inside the created emit gets the queue ahead of every
    // continuation the bind awaits, so it lands before the bind returns. An await
    // between the emit and the bind would run it before the BIND entry instead.
    expect(entries()).toEqual([
      { event: CREATED, data: { sessionId: child.sessionId, parentSessionId: PARENT_ID } },
      { event: BIND },
      { event: MICROTASK },
      { event: BOUND, data: { sessionId: child.sessionId, parentSessionId: PARENT_ID } },
    ]);

    await disposeChildSession(child);
  });
});
