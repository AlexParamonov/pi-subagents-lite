/**
 * session.ts — the workflow acceptance session the workflow slices share: start the extension the
 * way Pi starts it (session_start, then the first turn that builds the widget), call the tools it
 * registered, and read back the surfaces one session produces - the `AgentStatus` listing, the
 * completion notifications, the widget's rows, a rendered component's rows.
 *
 * Pi stays the only mocked boundary here: `sendMessage`, the UI context and the TUI are fakes, while
 * the tools, the widget factory and the renderers are the registered production ones driven over the
 * test endpoint in `fixtures.ts`. Everything in this module is per-session or pure: the clock a test
 * controls (real timers vs `clockedLoopback`) and the endpoint script stay with the test, because
 * waiting for a notification on a virtual clock is not the same operation as waiting on a real one.
 */

import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, vi } from "vite-plus/test";
import {
  createMockExtensionAPI,
  fakeCtx,
  loadExtension,
  type MockExtensionAPI,
  type RegisteredTool,
} from "../fixtures.js";
import { asTui } from "../pi-boundaries.js";
import { defaultTheme, defaultUi } from "../mock-utils.js";
import type { Workspace } from "./fixtures.js";

type Result = AgentToolResult<Record<string, unknown>>;
type Update = AgentToolUpdateCallback<Record<string, unknown>>;

/** The tool call id both slices address the `Workflow` tool with: a row is rendered for this call. */
export const WORKFLOW_CALL = "workflow-call";

/** A tool Pi can call, with its `execute` exposed. */
export interface ExecutableTool extends RegisteredTool {
  execute(
    id: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    update: Update | undefined,
    ctx: ExtensionContext,
  ): Promise<Result>;
}

/** One hand Pi received: the message, plus the options it was delivered with. */
export interface Nudge {
  message: { customType: string; content: string; display: boolean; details: unknown };
  options: unknown;
}

export interface WorkflowSession {
  /** The captured Pi API: registered tools, commands, listeners and renderers live here. */
  capture: MockExtensionAPI;
  /** The session context the tools are called with. */
  ctx: ExtensionContext;
  /** What `ui.notify` was told, in order. */
  notices: string[];
  /** The tool registered last under `name`, with `execute` exposed. */
  tool(name?: string): ExecutableTool;
  /** Call the registered `Workflow` tool the way Pi calls it. */
  run(args: Record<string, unknown>, signal?: AbortSignal, update?: Update): Promise<Result>;
  /** What the `AgentStatus` tool prints. */
  status(): Promise<string>;
  /** What the `StopAgent` tool answers for `id`. */
  stop(id: string): Promise<string>;
  /** Everything this session was handed as a completion notification. */
  nudges(): Nudge[];
  /** The widget's rows, reached through `setWidget` as Pi reaches them. */
  widgetText(): string;
  /** End the session the way Pi does; a repeat call is the cleanup that finds it already ended. */
  shutdown(): Promise<void>;
}

export interface WorkflowSessionOptions {
  /** The project the session runs in - usually `ws.project`. */
  cwd: string;
  /** Whether the parent session is idle: it decides how a settlement is delivered. */
  parentIdle?: boolean;
  /** Counts the repaints the widget asks for, for the tests that watch the refresh timer. */
  requestRender?: () => void;
}

/**
 * Start the session the way Pi does, with the widget's host attached: `setWidget` hands back the
 * content the widget registered, and the first turn is what builds it, exactly as in a live session.
 * The workflow file and the endpoint config must be installed first: the session reads them as it
 * starts.
 */
export async function startWorkflowSession(options: WorkflowSessionOptions): Promise<WorkflowSession> {
  const capture = createMockExtensionAPI();
  const notices: string[] = [];
  const tui = asTui({
    terminal: { columns: 240, rows: 24 },
    ...(options.requestRender ? { requestRender: options.requestRender } : {}),
  });
  const theme = { ...defaultTheme, bg: (_color: string, line: string) => line };
  let widget: { render(): string[] } | undefined;
  const ctx = fakeCtx({
    cwd: options.cwd,
    isIdle: () => options.parentIdle ?? true,
    ui: {
      ...defaultUi,
      notify: (message: string) => notices.push(message),
      setStatus: () => {},
      setWidget: (_key: string, content: unknown) => {
        const build = content as ((tui: unknown, theme: unknown) => { render(): string[] }) | undefined;
        widget = build ? build(tui, theme) : undefined;
      },
    },
  });
  await loadExtension(capture.api);
  await fire(capture, ctx, "session_start", { type: "session_start", reason: "startup" });
  await fire(capture, ctx, "turn_start", { type: "turn_start" });
  let ended = false;

  const call = (name: string, id: string, args: Record<string, unknown>): Promise<Result> =>
    tool(capture, name).execute(id, args, undefined, undefined, ctx);
  return {
    capture,
    ctx,
    notices,
    tool(name = "Workflow") {
      return tool(capture, name);
    },
    run(args, signal, update) {
      return tool(capture).execute(WORKFLOW_CALL, args, signal, update, ctx);
    },
    async status() {
      return text(await call("AgentStatus", "status-call", {}));
    },
    async stop(id) {
      return text(await call("StopAgent", "stop-call", { agent_id: id }));
    },
    nudges() {
      return nudges(capture);
    },
    widgetText() {
      expect(widget, "the extension must register a widget").toBeDefined();
      return widget!
        .render()
        .filter((row) => row !== "")
        .join("\n");
    },
    async shutdown() {
      if (ended) return;
      ended = true;
      await fire(
        capture,
        ctx,
        "session_shutdown",
        { type: "session_shutdown", reason: "quit" },
        "Pi must be able to end the session",
      );
    },
  };
}

/** Point the extension's agent directory at `ws`, the file Pi's session start then reads. */
export function mockAgentDir(ws: Workspace): void {
  vi.resetModules();
  vi.doMock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
    getAgentDir: () => ws.agentDir,
  }));
}

/**
 * Fire one session event the way Pi fires it. The reason names what must answer, because a missing
 * listener is the failure every one of these tests would otherwise hit as an opaque call result.
 */
async function fire(
  capture: MockExtensionAPI,
  ctx: ExtensionContext,
  event: string,
  payload: Record<string, unknown>,
  reason = `the extension must handle ${event}`,
): Promise<void> {
  const handler = capture.listeners.find((entry) => entry.event === event)?.handler;
  expect(handler, reason).toBeTypeOf("function");
  await handler!(payload, ctx);
}

/** The tool registered last under `name`, with the same named failure its absence would produce. */
export function tool(capture: MockExtensionAPI, name = "Workflow"): ExecutableTool {
  const registered = capture.tools.filter((entry) => entry.name === name).at(-1) as ExecutableTool | undefined;
  expect(registered?.execute, `Pi must be able to call ${name}`).toBeTypeOf("function");
  return registered!;
}

/** The text a tool result carries, as the session reads it. */
export function text(result: Result): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/** Await a call's outcome the way its caller reports it: a throw becomes the error text. */
export async function report(pending: Promise<Result>): Promise<{ isError: boolean; text: string }> {
  try {
    const result = await pending;
    return { isError: result.isError ?? false, text: text(result) };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { isError: true, text: error.message };
  }
}

/** The run id `AgentStatus` prints - the handle the caller addresses the run by. */
export function runId(listing: string): string {
  const id = listing.match(/\b[0-9a-f]{8}\b/)?.[0];
  expect(id, "AgentStatus must list the run by its short id").toBeTypeOf("string");
  return id!;
}

/** Everything the extension handed Pi as a completion notification. */
export function nudges(capture: MockExtensionAPI): Nudge[] {
  return capture.api.sendMessage.mock.calls.map(([message, options]) => ({
    message: message as Nudge["message"],
    options,
  }));
}

/** Rows a rendered component produced, without the padding each row carries. */
export function renderedRows(component: unknown): string[] {
  if (typeof component !== "object" || component === null || !("render" in component)) return [];
  if (typeof component.render !== "function") return [];
  const lines: unknown = (component.render as (width: number) => unknown)(240);
  return Array.isArray(lines)
    ? lines.filter((line): line is string => typeof line === "string").map((line) => line.trimEnd())
    : [];
}

/** The same rows as one block of text. */
export function rendered(component: unknown): string {
  return renderedRows(component).join("\n");
}
