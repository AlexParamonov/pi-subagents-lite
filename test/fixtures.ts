/**
 * fixtures.ts — Shared test fixtures and helpers for the subagents extension tests.
 *
 * Shared mock factories (for vi.mock call sites):
 *   - shellMock: ../src/shell.js stubs (parameterized by hoisted fns)
 */

import { vi } from "vitest";

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

export interface ShellMockFns {
  manager?: any;
  pi?: any;
  sessionCtx?: any;
  store?: any;
  coordinator?: any;
  widget?: any;
  /** Spawn guard state for isInsideSubagentSpawn/enter/exit. */
  spawnGuard?: { depth: number };
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
  // Mutable state so setters update what getters return.
  const state = {
    manager: fns.manager ?? {
      abort: vi.fn(),
      getRecord: vi.fn(),
      listAgents: vi.fn(() => []),
      spawn: vi.fn(),
      getTotalAgentCost: vi.fn(() => 0),
    },
    pi: fns.pi ?? { sendMessage: vi.fn(), exec: vi.fn() },
    sessionCtx: fns.sessionCtx ?? { cwd: "/home/test" },
    store: fns.store ?? {
      agent: { graceTurns: 6, forceBackground: false, showCost: false, agentToolStrictMode: false },
      modelFor: () => "anthropic/claude-sonnet-4-6",
    },
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
    setPiInstance: (pi: any) => {
      state.pi = pi;
    },
    setSessionCtx: (ctx: any) => {
      state.sessionCtx = ctx;
    },
    setManager: (m: any) => {
      state.manager = m;
    },
    setWidget: (w: any) => {
      state.widget = w;
    },
    setCoordinator: (c: any) => {
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

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/* ------------------------------------------------------------------ */
/*  Extension API mock                                                */
/* ------------------------------------------------------------------ */

export interface RegisteredTool {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string;
  parameters: any; // TypeBox TSchema
  execute?: (...args: any[]) => any;
}

export interface RegisteredCommand {
  name: string;
  description: string;
  handler: (...args: any[]) => any;
}

export interface ListenerRegistration {
  event: string;
  handler: (...args: any[]) => any;
}

export interface RegisteredMessageRenderer {
  customType: string;
  renderer: (...args: any[]) => any;
}

export interface MockExtensionAPI {
  tools: RegisteredTool[];
  commands: RegisteredCommand[];
  listeners: ListenerRegistration[];
  messageRenderers: RegisteredMessageRenderer[];
  api: {
    registerTool: ReturnType<typeof vi.fn>;
    registerCommand: ReturnType<typeof vi.fn>;
    registerMessageRenderer: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    sendUserMessage: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
  };
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
      registerTool: vi.fn((tool: any) => {
        tools.push(tool);
      }),
      registerCommand: vi.fn((name: string, opts: any) => {
        commands.push({ name, ...opts });
      }),
      registerMessageRenderer: vi.fn((customType: string, renderer: any) => {
        messageRenderers.push({ customType, renderer });
      }),
      on: vi.fn((event: string, handler: any) => {
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
export async function loadExtension(api: any) {
  const factory = (await import("../src/index.js")).default;
  return factory(api);
}

/* ------------------------------------------------------------------ */
/*  Mock session for output-file tests                                */
/* ------------------------------------------------------------------ */

export interface MockSession {
  messages: Array<{ role: string; content: any }>;
  subscribe: ReturnType<typeof vi.fn>;
  _addMessage: (role: string, content: string) => void;
  _fireTurnEnd: () => void;
  _fireMessageStart: () => void;
  _fireThinkingStart: () => void;
  _fireThinkingDelta: (delta: string) => void;
  _fireThinkingEnd: (content: string) => void;
  _getListeners: () => Array<(event: any) => void>;
  _fireCompactionStart: (reason: string) => void;
  _fireCompactionEnd: (event: { reason: string; aborted: boolean; result?: any }) => void;
}

/**
 * Create a mock agent session for testing streamToOutputFile.
 */
export function createMockSession(): MockSession {
  const listeners: Array<(event: any) => void> = [];
  let msgIdx = 0;

  return {
    messages: [] as Array<{ role: string; content: any }>,
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    }),
    _addMessage: (role: string, content: string) => {
      msgIdx++;
      const msg: any = { role, content };
      if (role === "assistant") {
        msg.content = [{ type: "text", text: content }];
      }
      (msg as any)._idx = msgIdx;
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
    _fireCompactionEnd: (event: { reason: string; aborted: boolean; result?: any }) => {
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

/**
 * Create a minimal fake pi context for agent tests.
 */
export function fakeCtx(): any {
  return {
    cwd: "/home/test/project",
    modelRegistry: { find: vi.fn() },
    model: { provider: "test", id: "model" },
    getSystemPrompt: vi.fn(),
  };
}

/**
 * Create a minimal fake pi instance for agent tests.
 */
export function fakePi(): any {
  return { exec: vi.fn() };
}

/**
 * Create a resolvable promise for async concurrency tests.
 */
export function makeResolvablePromise() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>((r) => {
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
