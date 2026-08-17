/**
 * fixtures.ts — Shared test fixtures and helpers for the subagents extension tests.
 *
 * Shared mock factories (for vi.mock call sites):
 *   - shellMock: ../src/shell.js stubs (parameterized by hoisted fns)
 */

import { vi, type Mock } from "vitest";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { shallowMerge, defaultUi, defaultSessionManager, defaultModel, defaultModelRegistry } from "./mock-utils.js";
import type { TObject } from "@sinclair/typebox";
import { asExtensionAPI } from "./pi-boundaries.js";
import type { AgentManager } from "../src/agents/agent-manager.js";
import type { SubagentsConfig } from "../src/models/model-precedence.js";
import type { SpawnCoordinator } from "../src/spawn/spawn-coordinator.js";
import type { AgentWidget } from "../src/ui/agent-widget.js";

/* ================================================================== */
/*  Shared mock factories                                             */
/*  These return factory bodies for vi.mock() calls.                  */
/*  Each test file keeps its own vi.mock("path", factory) line;       */
/*  only the factory BODY is deduplicated here.                       */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/*  Per-test-overridable mock builders                                */
/*  These accept hoisted fns from the test file so behavior can be    */
/*  controlled per-test. The test file keeps its own vi.hoisted().    */
/* ------------------------------------------------------------------ */

/** The partial ConfigStore projection the shell mock serves. */
export interface MockShellStore {
  agent: Partial<SubagentsConfig["agent"]>;
  modelFor?: (type: string, parentModelId: string, agentConfig?: { model?: string }) => string;
}

export interface ShellMockFns {
  manager?: Partial<AgentManager>;
  pi?: Partial<ExtensionAPI>;
  sessionCtx?: Partial<ExtensionContext>;
  store?: MockShellStore;
  coordinator?: Partial<SpawnCoordinator>;
  widget?: AgentWidget;
  /** Spawn guard state for isInsideSubagentSpawn/enter/exit. */
  spawnGuard?: { depth: number };
}

/** Mutable mock state; setters update what the getters return. */
interface ShellMockState {
  manager: Partial<AgentManager> | null;
  pi: Partial<ExtensionAPI>;
  sessionCtx: Partial<ExtensionContext>;
  store: MockShellStore;
  coordinator: Partial<SpawnCoordinator> | null;
  widget: AgentWidget | null | undefined;
  spawnGuard: { depth: number };
}

/**
 * ../src/shell.js mock builder.
 * Accepts partial overrides; defaults to no-op stubs.
 * Pass hoisted fns for per-test behavioral control.
 *
 * Usage:
 *   const { mockAbort } = vi.hoisted(() => ({ mockAbort: vi.fn() }));
 *   vi.mock("../src/shell.js", () => shellMock({
 *     manager: { abort: mockAbort, getRecord: vi.fn(), listAgents: vi.fn() },
 *   }));
 */
export function shellMock(fns: ShellMockFns = {}) {
  const state: ShellMockState = {
    manager:
      fns.manager ??
      ({
        abort: vi.fn(),
        getRecord: vi.fn(),
        listAgents: vi.fn(() => []),
        spawn: vi.fn(),
        getTotalAgentCost: vi.fn(() => 0),
      } satisfies Partial<AgentManager>),
    pi: fns.pi ?? { sendMessage: vi.fn(), exec: vi.fn() },
    sessionCtx: fns.sessionCtx ?? { cwd: "/home/test" },
    store:
      fns.store ??
      ({
        agent: {
          graceTurns: 6,
          forceBackground: false,
          showCost: false,
          agentToolStrictMode: false,
        },
        modelFor: () => "anthropic/claude-sonnet-4-6",
      } satisfies MockShellStore),
    coordinator: fns.coordinator ?? { spawn: vi.fn() },
    widget: fns.widget ?? undefined,
    spawnGuard: fns.spawnGuard ?? { depth: 0 },
  };

  return {
    getManager: () => state.manager,
    getPiInstance: () => state.pi,
    getSessionCtx: () => state.sessionCtx,
    getStore: () => state.store,
    getCoordinator: () => state.coordinator,
    getWidget: () => state.widget,
    setPiInstance: (pi: Partial<ExtensionAPI>) => {
      state.pi = pi;
    },
    setSessionCtx: (ctx: Partial<ExtensionContext>) => {
      state.sessionCtx = ctx;
    },
    setManager: (m: Partial<AgentManager> | null) => {
      state.manager = m;
    },
    setWidget: (w: AgentWidget | null) => {
      state.widget = w;
    },
    setCoordinator: (c: Partial<SpawnCoordinator> | null) => {
      state.coordinator = c;
    },
    isInsideSubagentSpawn: () => state.spawnGuard.depth > 0,
    enterSubagentSpawn: () => {
      state.spawnGuard.depth++;
    },
    exitSubagentSpawn: () => {
      state.spawnGuard.depth--;
    },
  };
}

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/* ------------------------------------------------------------------ */
/*  Extension API mock                                                */
/* ------------------------------------------------------------------ */

export interface RegisteredTool {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: TObject;
  /** Provider-side json_schema enforcement; mirrors src/registration.ts. */
  constrainedSampling?: { type: string; strict: string };
  renderCall?: (args: Record<string, unknown>, theme: unknown) => unknown;
  renderResult?: (
    result: { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; isError?: boolean },
    options: { expanded?: boolean },
    theme: unknown,
    context?: { isError?: boolean; toolCallId?: string; [key: string]: unknown },
  ) => unknown;
}

export interface RegisteredCommand {
  name: string;
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

/**
 * A captured event listener. The handler is a real src callback that tests
 * drive with synthetic events and partial ctx fakes, so its parameters
 * stay wide (no real event/ctx type admits the test's partial fakes).
 */
export type ListenerHandler = (event: unknown, ctx: unknown) => Promise<void> | void;

export interface ListenerRegistration {
  event: string;
  handler: ListenerHandler;
}

/**
 * A captured message renderer, invoked by tests with the partial
 * message/options/theme shapes src's subagent-result renderer reads.
 */
export type MessageRendererCapture = (
  message: { content?: string; details?: Record<string, unknown> },
  options: { expanded?: boolean },
  theme: { fg: (color: string, text: string) => string; bg: (color: string, text: string) => string },
) => { children: unknown };

export interface RegisteredMessageRenderer {
  customType: string;
  renderer: MessageRendererCapture;
}

export interface MockExtensionApi {
  registerTool: Mock<(tool: RegisteredTool) => void>;
  registerCommand: Mock<(name: string, options: Omit<RegisteredCommand, "name">) => void>;
  registerMessageRenderer: Mock<(customType: string, renderer: MessageRendererCapture) => void>;
  on: Mock<(event: string, handler: ListenerHandler) => void>;
  sendUserMessage: Mock;
  sendMessage: Mock;
  exec: Mock;
}

export interface MockExtensionAPI {
  tools: RegisteredTool[];
  commands: RegisteredCommand[];
  listeners: ListenerRegistration[];
  messageRenderers: RegisteredMessageRenderer[];
  api: MockExtensionApi;
}

/**
 * Create a mock ExtensionAPI that captures registered tools, commands, and listeners.
 */
export function createMockExtensionAPI(): MockExtensionAPI {
  const tools: RegisteredTool[] = [];
  const commands: RegisteredCommand[] = [];
  const listeners: ListenerRegistration[] = [];
  const messageRenderers: RegisteredMessageRenderer[] = [];

  return {
    tools,
    commands,
    listeners,
    messageRenderers,
    api: {
      registerTool: vi.fn((tool: RegisteredTool) => {
        tools.push(tool);
      }),
      registerCommand: vi.fn((name: string, options: Omit<RegisteredCommand, "name">) => {
        commands.push({ name, ...options });
      }),
      registerMessageRenderer: vi.fn((customType: string, renderer: MessageRendererCapture) => {
        messageRenderers.push({ customType, renderer });
      }),
      on: vi.fn((event: string, handler: ListenerHandler) => {
        listeners.push({ event, handler });
      }),
      sendUserMessage: vi.fn(),
      sendMessage: vi.fn(),
      exec: vi.fn(),
    },
  };
}

/**
 * Import and invoke the extension factory.
 */
export async function loadExtension(api: MockExtensionApi) {
  const factory = (await import("../src/index.js")).default;
  return factory(asExtensionAPI(api));
}

/* ------------------------------------------------------------------ */
/*  Mock session for output-file tests                                */
/* ------------------------------------------------------------------ */

/**
 * The events the mock session fires — the subset of the real session
 * event union that src's output-file streaming reacts to.
 */
export type MockSessionEvent =
  | { type: "turn_end" }
  | { type: "message_start" }
  | {
      type: "message_update";
      assistantMessageEvent:
        | { type: "thinking_start" }
        | { type: "thinking_delta"; delta: string }
        | { type: "thinking_end"; content: string };
    }
  | { type: "compaction_start"; reason: string }
  | { type: "compaction_end"; reason: string; aborted: boolean; result?: unknown };

export interface MockSessionMessage {
  role: string;
  content: string | Array<{ type: string; text: string }>;
  _idx?: number;
}

type MockSessionListener = (event: MockSessionEvent) => void;

export interface MockSession {
  messages: MockSessionMessage[];
  subscribe: Mock<(listener: MockSessionListener) => () => void>;
  _addMessage: (role: string, content: string) => void;
  _fireTurnEnd: () => void;
  _fireMessageStart: () => void;
  _fireThinkingStart: () => void;
  _fireThinkingDelta: (delta: string) => void;
  _fireThinkingEnd: (content: string) => void;
  _getListeners: () => MockSessionListener[];
  _fireCompactionStart: (reason: string) => void;
  _fireCompactionEnd: (event: { reason: string; aborted: boolean; result?: unknown }) => void;
}

/**
 * Create a mock agent session for testing streamToOutputFile.
 */
export function createMockSession(): MockSession {
  const listeners: MockSessionListener[] = [];
  let msgIdx = 0;

  return {
    messages: [],
    subscribe: vi.fn((listener: MockSessionListener) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    }),
    _addMessage: (role: string, content: string) => {
      msgIdx++;
      const msg: MockSessionMessage = { role, content };
      if (role === "assistant") {
        msg.content = [{ type: "text", text: content }];
      }
      msg._idx = msgIdx;
    },
    _fireTurnEnd: () => {
      for (const fn of listeners) fn({ type: "turn_end" });
    },
    _fireMessageStart: () => {
      for (const fn of listeners) fn({ type: "message_start" });
    },
    _fireThinkingStart: () => {
      for (const fn of listeners)
        fn({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_start" },
        });
    },
    _fireThinkingDelta: (delta: string) => {
      for (const fn of listeners)
        fn({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta },
        });
    },
    _fireThinkingEnd: (content: string) => {
      for (const fn of listeners)
        fn({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_end", content },
        });
    },
    _fireCompactionStart: (reason: string) => {
      for (const fn of listeners) fn({ type: "compaction_start", reason });
    },
    _fireCompactionEnd: (event: { reason: string; aborted: boolean; result?: unknown }) => {
      for (const fn of listeners)
        fn({ type: "compaction_end", reason: event.reason, aborted: event.aborted, result: event.result });
    },
    _getListeners: () => listeners,
  };
}

/* ------------------------------------------------------------------ */
/*  Temp directory fixture                                            */
/* ------------------------------------------------------------------ */

/**
 * Returns a setup/teardown pair for a temp directory.
 * Call setup() in beforeEach, teardown() in afterEach.
 */
export function tempDirFixture(prefix = "subagents-test") {
  let tmpDir: string;

  return {
    setup: () => {
      tmpDir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(tmpDir, { recursive: true });
      return tmpDir;
    },
    getDir: () => tmpDir,
    teardown: () => {
      if (tmpDir) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Agent markdown helpers                                            */
/* ------------------------------------------------------------------ */

/**
 * Build a minimal agent .md content string with frontmatter.
 * Fields are snake_case as they would appear in frontmatter.
 * Pass `_skip: string[]` to omit any fields from the defaults.
 */
export function makeAgentMd(overrides: Record<string, unknown> = {}): string {
  const skipFields = (overrides._skip as string[]) ?? [];
  const defaults: Record<string, string> = {
    name: "test-agent",
    description: "A test agent",
    model: "anthropic/claude-sonnet-4-6",
    display_name: "Test Agent",
    tools: "read, bash, edit",
    extensions: "true",
    skills: "true",
    thinking: "off",
    max_turns: "25",
    disallowed_tools: "",
    enabled: "true",
  };
  const fm: Record<string, string> = { ...defaults };
  for (const [key, val] of Object.entries(overrides)) {
    if (key === "_skip") continue;
    if (val === undefined) {
      delete fm[key];
    } else {
      fm[key] = String(val);
    }
  }
  for (const key of skipFields) {
    delete fm[key];
  }
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${yaml}\n---\n\nSystem prompt body text.`;
}

/**
 * Create a temp directory with agent .md files for scanAgentFilesInDir tests.
 * Returns { dir, cleanup } — call cleanup() in afterEach.
 */
export function tempDirWithFiles(
  files: Array<{ name: string; content: string }>,
  prefix = "agent-test",
): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    writeFileSync(join(dir, file.name), file.content);
  }
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Fake context / pi                                                 */
/* ------------------------------------------------------------------ */

/** Options for overriding specific fields of the default fake context. */
export interface FakeCtxOptions {
  ui?: Partial<ExtensionUIContext>;
  mode?: "tui" | "rpc" | "json" | "print";
  hasUI?: boolean;
  cwd?: string;
  modelRegistry?: ExtensionContext["modelRegistry"];
  model?: ExtensionContext["model"];
  scopedModels?: ExtensionContext["scopedModels"];
  thinkingLevel?: ExtensionContext["thinkingLevel"];
  isIdle?: ExtensionContext["isIdle"];
  isProjectTrusted?: ExtensionContext["isProjectTrusted"];
  signal?: ExtensionContext["signal"];
  abort?: ExtensionContext["abort"];
  hasPendingMessages?: ExtensionContext["hasPendingMessages"];
  shutdown?: ExtensionContext["shutdown"];
  getContextUsage?: ExtensionContext["getContextUsage"];
  compact?: ExtensionContext["compact"];
  getSystemPrompt?: ExtensionContext["getSystemPrompt"];
}

/**
 * Create a fake ExtensionContext with typed defaults for all required fields.
 * Pass an options object to override specific fields.
 */
export function fakeCtx(options: FakeCtxOptions = {}): ExtensionContext {
  const defaults: ExtensionContext = {
    ui: defaultUi,
    mode: "tui",
    hasUI: true,
    cwd: "/home/test/project",
    sessionManager: defaultSessionManager(),
    modelRegistry: defaultModelRegistry(),
    model: defaultModel(),
    scopedModels: [],
    thinkingLevel: undefined,
    isIdle: vi.fn(() => true),
    isProjectTrusted: vi.fn(() => true),
    signal: undefined,
    abort: vi.fn(),
    hasPendingMessages: vi.fn(() => false),
    shutdown: vi.fn(),
    getContextUsage: vi.fn(() => undefined),
    compact: vi.fn(),
    getSystemPrompt: vi.fn(() => ""),
  };
  return shallowMerge(defaults, options as Partial<ExtensionContext>, false);
}

/**
 * Create a minimal fake pi instance for agent tests.
 */
export function fakePi() {
  return asExtensionAPI({ exec: vi.fn() });
}

/**
 * Create a resolvable promise for async concurrency tests.
 */
export function makeResolvablePromise() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/* ------------------------------------------------------------------ */
/*  Skill file helpers                                                */
/* ------------------------------------------------------------------ */

/**
 * Create a skill directory with SKILL.md in <tmpDir>/.pi/skills/<name>/.
 */
export function createSkillDir(tmpDir: string, name: string, description: string, body: string) {
  const skillDir = join(tmpDir, ".pi", "skills", name);
  mkdirSync(skillDir, { recursive: true });
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
  writeFileSync(join(skillDir, "SKILL.md"), content);
}

/**
 * Create a flat skill file in <tmpDir>/.pi/skills/<name>.md.
 */
export function createFlatSkill(tmpDir: string, name: string, description: string, body: string) {
  const skillsDir = join(tmpDir, ".pi", "skills");
  mkdirSync(skillsDir, { recursive: true });
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
  writeFileSync(join(skillsDir, `${name}.md`), content);
}
