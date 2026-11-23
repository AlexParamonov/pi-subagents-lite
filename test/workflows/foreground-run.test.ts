/**
 * foreground-run.test.ts — the Workflow tool, end to end, through the seam the main agent uses.
 *
 * Every test enters at a caller-visible seam - a registered tool (`Workflow`, `AgentStatus`,
 * `StopAgent`, `MessageAgent`), the `/agents` command's real menu components, or a session
 * listener - and the Workflow endpoint is the real HTTP protocol on a loopback socket (or
 * `fakeWorkflowFetch` where a test pushes frames itself or fake timers must own the clock).
 * Nothing from `src/` is imported or mocked, so a passing test means the definition on disk
 * reached the endpoint and the endpoint's answer reached the transcript. The protocol bodies and
 * SSE frames this suite replays are recorded from the workflow API (`recorded/`), apart from the
 * contract-derived declared-output payload `recorded/PROVENANCE.md` names; the in-runtime fetch/SSE
 * proof belongs to the wave's live tmux gate.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createMockExtensionAPI,
  fakeCtx,
  loadExtension,
  type MockExtensionAPI,
  type RegisteredTool,
} from "../fixtures.js";
import { asCommandContext, asUiCustom } from "../pi-boundaries.js";
import { defaultTheme, defaultUi } from "../mock-utils.js";
import {
  beforeEnd,
  COMPLETED_RUN,
  configure,
  CHUNK_MULTILINE,
  CONTROL_FRAMES,
  createRequests,
  declaredOutputRead,
  deferred,
  DEFAULT_RESULT,
  endpoint,
  errorBody,
  fakeWorkflowFetch,
  FAILED_RUN,
  jsonResponse,
  readRequests,
  readState,
  RECORDED,
  recordedResponse,
  recordedRead,
  REMOTE_ID,
  REPLAY_COMPLETED_STREAM,
  REPLAY_DECLARED_STREAM,
  REPLAY_FAILED_STREAM,
  stateReply,
  stopAck,
  stopRequests,
  streamRequests,
  PING,
  RECONNECT,
  FAKED_URL,
  DEFAULT_STREAM,
  DISPATCH,
  crlf,
  lifecycle,
  progressFrame,
  TERMINAL,
  textFrame,
  THINKING_MULTILINE,
  workspace,
  write,
  workflow,
  type EndpointOptions,
  type TestEndpoint,
  type Workspace,
} from "./fixtures.js";

let ws: Workspace;
let api: MockExtensionAPI | undefined;
let ctx: ExtensionContext | undefined;
let endpoints: TestEndpoint[];

type WorkflowResult = AgentToolResult<Record<string, unknown>>;
type WorkflowUpdate = AgentToolUpdateCallback<Record<string, unknown>>;

interface ExecutableTool extends RegisteredTool {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: WorkflowUpdate | undefined,
    context: ExtensionContext,
  ): Promise<WorkflowResult>;
}

beforeEach(() => {
  ws = workspace();
  endpoints = [];
  vi.resetModules();
  vi.doMock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
    getAgentDir: () => ws.agentDir,
  }));
});

afterEach(async () => {
  const shutdown = api?.listeners.find((listener) => listener.event === "session_shutdown");
  if (shutdown && ctx) await shutdown.handler({ type: "session_shutdown", reason: "quit" }, ctx);
  for (const server of endpoints) await server.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  api = undefined;
  ctx = undefined;
  vi.restoreAllMocks();
  vi.doUnmock("@earendil-works/pi-coding-agent");
  rmSync(ws.root, { recursive: true, force: true });
});

async function start(trusted = true, warnings?: string[]): Promise<MockExtensionAPI> {
  api = createMockExtensionAPI();
  if (warnings) {
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => warnings.push(args.map(String).join(" ")));
  }
  ctx = fakeCtx({
    cwd: ws.project,
    isProjectTrusted: () => trusted,
    ...(warnings && {
      ui: {
        ...defaultUi,
        notify: (message, type) => {
          if (type === "warning") warnings.push(message);
        },
      },
    }),
  });
  await loadExtension(api.api);
  const startListener = api.listeners.find((listener) => listener.event === "session_start");
  expect(startListener, "the extension must handle session start").toBeDefined();
  await startListener!.handler({ type: "session_start", reason: "startup" }, ctx);
  return api;
}

function workflowTool(api: MockExtensionAPI) {
  return api.tools.filter((tool) => tool.name === "Workflow").at(-1);
}

function executable(api: MockExtensionAPI, name = "Workflow"): ExecutableTool {
  const tool = api.tools.filter((candidate) => candidate.name === name).at(-1) as ExecutableTool | undefined;
  expect(tool, `the ${name} tool must be registered`).toBeDefined();
  expect(tool?.execute, `the ${name} tool must be executable`).toBeTypeOf("function");
  return tool!;
}

async function server(options?: EndpointOptions): Promise<TestEndpoint> {
  const instance = await endpoint(options);
  endpoints.push(instance);
  return instance;
}

/** The default workflow file on disk plus the config that sends a run to this endpoint. */
function install(remote: TestEndpoint, apiKey?: string): void {
  write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
  configure(ws, remote.url, apiKey);
}

function text(result: WorkflowResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function run(
  tool: ExecutableTool,
  params: Record<string, unknown> = { workflow: "audit", prompt: "Review changes" },
  signal?: AbortSignal,
  onUpdate?: WorkflowUpdate,
): Promise<WorkflowResult> {
  return tool.execute("workflow-call", params, signal, onUpdate, ctx!);
}

/** Advance the fake clock in steps: each step yields, so the loop's own stream and read promises settle between timers. */
async function pump(steps: number, msEach: number): Promise<void> {
  for (let index = 0; index < steps; index += 1) await vi.advanceTimersByTimeAsync(msEach);
}

async function outcome(tool: ExecutableTool, params?: Record<string, unknown>, signal?: AbortSignal) {
  try {
    const result = await run(tool, params, signal);
    return { text: text(result), isError: result.isError ?? false };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { text: error.message, isError: true };
  }
}

function createRequest(remote: TestEndpoint) {
  const [request] = createRequests(remote);
  expect(request, "the endpoint must receive the selected workflow").toBeDefined();
  return request!;
}

/** The run id AgentStatus prints — the handle the main agent passes to StopAgent. */
function listedRunId(status: WorkflowResult): string {
  const id = text(status).match(/\b[0-9a-f]{8}\b/)?.[0];
  expect(id, "AgentStatus must list the workflow run by id").toBeDefined();
  return id!;
}

/** Run the extension's session shutdown against the current context. */
async function shutdownSession(capture: MockExtensionAPI): Promise<void> {
  const shutdown = capture.listeners.find((listener) => listener.event === "session_shutdown");
  expect(shutdown, "the extension must handle session shutdown").toBeDefined();
  await shutdown!.handler({ type: "session_shutdown", reason: "quit" }, ctx);
  ctx = undefined;
}

/** Every line the extension writes to the console while the test runs. */
function captureConsole(): string[] {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  for (const level of ["log", "info", "debug", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation(record);
  }
  return lines;
}

/** A menu component as the tests drive it: real pi-tui components, rendered to text. */
interface MenuComponent {
  render(width: number): unknown;
  handleInput?(data: string): void;
}

/**
 * Open the `/agents` command's running-agents list through the real menu components.
 * `ui.custom` is captured, so navigation is real key input on real components:
 * Enter on the main menu opens Running agents (its first entry).
 */
async function openRunningAgents(capture: MockExtensionAPI): Promise<MenuComponent> {
  const command = capture.commands.find((entry) => entry.name === "agents");
  expect(command, "the extension must register the agents menu command").toBeDefined();
  const menus: MenuComponent[] = [];
  const menuCtx = fakeCtx({
    cwd: ws.project,
    ui: {
      ...defaultUi,
      custom: asUiCustom(
        async (factory: unknown) =>
          new Promise<undefined>((resolve) => {
            const build = factory as (
              tui: unknown,
              theme: unknown,
              kb: unknown,
              done: (value: undefined) => void,
            ) => unknown;
            menus.push(build({ terminal: { rows: 24 } }, defaultTheme, {}, resolve) as MenuComponent);
          }),
      ),
    },
  });
  const open = command!.handler("", asCommandContext(menuCtx));
  void open.catch(() => {});

  await vi.waitFor(() => expect(menus, "the agents command must open its main menu").toHaveLength(1));
  menus[0].handleInput?.("\r");
  await vi.waitFor(() =>
    expect(menus, "the main menu's first entry must open the running-agents list").toHaveLength(2),
  );
  // The shared menu's own title: proof the navigation landed on the run list, not on a
  // re-rendered main menu.
  expect(rendered(menus[1])).toContain("Running Agents");
  return menus[1];
}

function selectionDescription(api: MockExtensionAPI): string {
  const property = workflowTool(api)?.parameters.properties.workflow as { description?: string } | undefined;
  return property?.description ?? "";
}

/** The component's rows, without the trailing padding pi-tui pads every rendered line out to. */
function renderedRows(component: unknown): string[] {
  if (typeof component !== "object" || component === null || !("render" in component)) return [];
  if (typeof component.render !== "function") return [];
  const lines: unknown = component.render(240);
  return Array.isArray(lines)
    ? lines.filter((line): line is string => typeof line === "string").map((line) => line.trimEnd())
    : [];
}

function rendered(component: unknown): string {
  return renderedRows(component).join("\n");
}

/**
 * The live view of a run, painted the way the tool call paints it. Every snapshot of one run shares
 * `args` and one render state: partial renders must reuse it, or the rows an earlier update
 * delivered are not the rows the call shows.
 */
function liveViews(tool: ExecutableTool, args: Record<string, unknown>) {
  const views: string[] = [];
  const state: Record<string, unknown> = {};
  return {
    views,
    paint(update: WorkflowResult): string {
      const view = resultView(tool, update, args, { state });
      views.push(view);
      return view;
    },
  };
}

/** Any terminal control character: C0 except the layout's own newline and tab, plus DEL and C1. */
function hasTerminalControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code < 0x20 && code !== 0x0a && code !== 0x09) || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/** Wait for a rendered snapshot satisfying `seen`, and return it; fails by name if the run ends first. */
async function viewMatching(
  views: string[],
  seen: (view: string) => boolean,
  what: string,
  ended: Promise<unknown>,
): Promise<string> {
  if (!views.some(seen)) {
    try {
      await beforeEnd(
        vi.waitFor(() => expect(views.some(seen), `no view matched: ${what}`).toBe(true), { interval: 1 }),
        ended,
        `a view where ${what}`,
      );
    } catch (error) {
      // The run can end in the same tick the view was recorded, and the recorded views are
      // history: only a view that never rendered is a failure.
      if (!views.some(seen)) throw error;
    }
  }
  return views.find(seen)!;
}

function resultView(
  tool: ExecutableTool,
  result: WorkflowResult,
  args: Record<string, unknown>,
  { invalidate = () => {}, state = {} }: { invalidate?: () => void; state?: Record<string, unknown> } = {},
): string {
  const options = { expanded: true, isPartial: true };
  const context = {
    args,
    toolCallId: "workflow-call",
    state,
    invalidate,
    cwd: ws.project,
    executionStarted: true,
    argsComplete: true,
    isPartial: true,
    expanded: true,
    showImages: false,
    isError: false,
  };
  return rendered(tool.renderResult?.(result, options, defaultTheme, context));
}

describe("foreground workflow execution", () => {
  it("returns the server's terminal answer for the selected definition", async () => {
    const remote = await server();
    install(remote, "example-key");
    const tool = executable(await start());

    const result = await run(tool, { workflow: "audit", prompt: "Review the repository" });

    expect(text(result)).toContain("The declared output");
    expect(text(result)).not.toContain("input_tokens");
    expect(text(result)).not.toContain("final_answer");
    const request = createRequest(remote);
    expect(request.authorization).toBe("Bearer example-key");
    expect(request.contentType).toMatch(/^application\/json(?:\s*;|$)/i);
    expect(JSON.parse(request.body)).toEqual({
      prompt: "Review the repository",
      workflow_config: {
        name: "audit",
        description: "Inspect a repository",
        nodes: [{ id: "analysis", params: { task_description: "{{task_description}}" } }],
        edges: [],
        entry_node: "analysis",
        prompt_vars: { working_dir: ws.project },
      },
    });
  });

  it("targets the selected endpoint with the requested working directory", async () => {
    const fallback = await server();
    const selected = await server();
    write(
      join(ws.agentDir, "workflows", "audit.yaml"),
      `${workflow()}endpoint: release\nprompt_vars:\n  branch: stable\n`,
    );
    write(
      join(ws.agentDir, "subagents-lite.json"),
      JSON.stringify({
        workflows: {
          endpoints: { local: { url: fallback.url }, release: { url: selected.url, apiKey: "release-key" } },
          defaultEndpoint: "local",
        },
      }),
    );
    const tool = executable(await start());

    const result = await run(tool, { workflow: "audit", prompt: "Review release", path: "/srv/checkout" });

    expect(text(result)).toContain("The declared output");
    const request = createRequest(selected);
    expect(request.authorization).toBe("Bearer release-key");
    expect(fallback.requests).toEqual([]);
    expect(JSON.parse(request.body)).toEqual({
      prompt: "Review release",
      workflow_config: {
        name: "audit",
        description: "Inspect a repository",
        nodes: [{ id: "analysis", params: { task_description: "{{task_description}}" } }],
        edges: [],
        entry_node: "analysis",
        prompt_vars: { branch: "stable", working_dir: "/srv/checkout" },
      },
    });
  });

  it("runs against the built-in local endpoint when no endpoint is configured", async () => {
    // The fetch fake stands in for the socket: asserting the built-in default must never
    // reach a real anagen-x listening on localhost:4001.
    const remote = fakeWorkflowFetch({
      stream: (push, close) => {
        push(DEFAULT_STREAM);
        close();
      },
      read: () => jsonResponse(200, readState({ result: DEFAULT_RESULT })),
    });
    write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
    vi.stubGlobal("fetch", remote.fetch);
    const tool = executable(await start());

    const result = await run(tool);

    expect(text(result)).toContain("The declared output");
    const create = remote.requests().find((request) => request.method === "POST");
    expect(create?.url).toBe("http://localhost:4001/api/workflows");
    expect(create?.authorization).toBeUndefined();
  });

  it("returns a no-output note for an empty completed result slot", async () => {
    // A completed node's own result is on the wire; it is not the run's output, and GET's
    // result slot is empty.
    const remote = await server({ result: null, streams: [DEFAULT_STREAM + lifecycle("node_complete", "other")] });
    install(remote);
    const tool = executable(await start());

    const result = await run(tool);

    expect(text(result)).toMatch(/no.*output/i);
    expect(text(result)).not.toContain(RECORDED.chunkText);
    expect(text(result)).not.toContain(RECORDED.nodeResult);
  });

  // The shape the server's own acceptance test pins for a `local` output node: the handler's inner
  // value, stored as the run's output, with no declared answer in it.
  it("publishes an undeclared output as that fact, and none of its data", async () => {
    const remote = await server({ result: { headline: "a long build narrative", chars: 22 } });
    install(remote);
    const tool = executable(await start());

    const result = await run(tool);

    expect(text(result)).toBe("The workflow run stored its output on the endpoint without declaring an answer.");
  });

  for (const reason of ["max_iterations"] as const) {
    it(`keeps ${String(reason)} termination provenance without leaking reasoning or usage`, async () => {
      const remote = await server({
        result: {
          text: "Visible answer",
          termination_reason: reason,
          thinking: "private reasoning",
          usage: { input_tokens: 341 },
        },
      });
      install(remote);
      const tool = executable(await start());

      const result = await run(tool);

      expect(text(result)).toContain("Visible answer");
      expect(text(result)).toContain(String(reason));
      expect(text(result)).not.toContain("private reasoning");
      expect(text(result)).not.toContain("input_tokens");
    });
  }

  // The endpoint reported no reason - either by omitting the key or by the `nil` a strategy with no
  // reason field answers - so the answer is everything the reader gets: the line this used to print
  // described a field the run never reported. Whatever else the value holds stays on the endpoint.
  it.for([{ reason: undefined }, { reason: null }])(
    "adds no provenance the endpoint did not report ($reason)",
    async ({ reason }) => {
      const value = { text: "Partial answer", termination_reason: reason, usage: { input_tokens: 2 } };
      const remote = await server({ result: value });
      install(remote);
      const tool = executable(await start());

      const result = await run(tool);

      expect(text(result)).toBe("Partial answer");
    },
  );

  // Whatever shape the producer's stored output has, an output with no declared `text` publishes that
  // fact and none of its data.
  for (const [label, value] of [
    ["map", { nested: null, values: [1, false] }],
    ["array", [{ text: "first" }, null] as unknown[]],
    ["number", 0],
    ["boolean", false],
  ] as const) {
    it(`publishes an undeclared ${label} output as that fact and quotes none of it`, async () => {
      const remote = await server({ result: value });
      install(remote);
      const tool = executable(await start());

      const result = await run(tool);

      expect(text(result)).toBe("The workflow run stored its output on the endpoint without declaring an answer.");
    });
  }

  it("rejects the retired completion marker and identifies the endpoint", async () => {
    const remote = await server({ result: { status: "completed" } });
    install(remote);
    const tool = executable(await start());

    const result = await outcome(tool);

    expect(result.isError).toBe(true);
    expect(result.text).toContain(remote.url);
    expect(result.text).toMatch(/result|output/i);
  });

  for (const status of ["failed", "interrupted"] as const) {
    it(`reports a remote ${status} with its reason and keeps it on the settled record`, async () => {
      const remote = await server({ states: [readState({ status, error: "Runner lost its lease" })] });
      install(remote);
      const capture = await start();
      const tool = executable(capture);
      const args = { workflow: "audit", prompt: "Review changes" };

      const result = await run(tool, args);
      const settled = resultView(tool, result, args);
      const listed = await run(executable(capture, "AgentStatus"), {});

      expect(result.isError).toBe(true);
      expect(text(result)).toContain("Runner lost its lease");
      // Once the record has settled it is the row's outcome source, and only record.error carries
      // this line: the repaint of a failed or interrupted run reads the record, not the call.
      expect(settled).toContain("Runner lost its lease");
      // US-18: a run the endpoint interrupted is an error record, never a stopped or completed one.
      expect(text(listed)).toContain("audit");
      expect(text(listed)).toMatch(/\berror\b/i);
      expect(text(listed)).not.toMatch(/stopped|completed|running/i);
      if (status === "interrupted") expect(text(result)).toMatch(/interrupt/i);
    });
  }

  it("renders one status line per node lifecycle event", async () => {
    const frames =
      lifecycle("node_dispatched", "analysis") +
      lifecycle("node_complete", "analysis") +
      lifecycle("node_dispatched", "report") +
      lifecycle("node_failed", "report") +
      lifecycle("node_dispatched", "review");
    const remote = await server({ streams: [frames], holdStream: true });
    install(remote);
    const tool = executable(await start());
    const args = { workflow: "audit", prompt: "Review changes" };
    const { views, paint } = liveViews(tool, args);

    const pending = run(tool, args, undefined, paint);

    // No text or activity frame is in this stream: every node name on screen came from a
    // lifecycle event, and each node carries its own state.
    const live = await viewMatching(
      views,
      (view) => ["analysis", "report", "review"].every((node) => view.includes(node)),
      "each of the three nodes has a status line",
      pending,
    );
    const lineFor = (node: string): string => {
      const line = live.split("\n").find((entry) => entry.includes(node));
      expect(line, `the live view must show a status line for the ${node} node`).toBeDefined();
      return line!;
    };
    expect(lineFor("analysis")).toMatch(/complete|finish|done|✓/i);
    expect(lineFor("report")).toMatch(/fail|error|✗/i);
    // Still in flight: the state belongs to the node, so it is not drawn as settled.
    expect(lineFor("review")).toMatch(/dispatch|start|running|pending|active|in progress|▶|…/i);
    expect(lineFor("review")).not.toMatch(/complete|finish|done|fail|error|✓|✗/i);

    remote.releaseStream();
    expect(text(await pending)).toContain("The declared output");
  });

  it("accumulates streamed chunks and replaces them with the node's full turn", async () => {
    const tail = "and reporting three findings.";
    const fullTurn = `Reading the changed files ${tail}`;
    let push: (frame: string) => void = () => {
      throw new Error("workflow stream did not open");
    };
    const remote = fakeWorkflowFetch({
      stream: (send) => {
        push = send;
        send(DISPATCH + textFrame("Reading the "));
      },
      read: () => jsonResponse(200, readState({ result: DEFAULT_RESULT })),
    });
    write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
    configure(ws, FAKED_URL);
    vi.stubGlobal("fetch", remote.fetch);
    const tool = executable(await start());
    const args = { workflow: "audit", prompt: "Review changes" };
    const { views, paint } = liveViews(tool, args);

    const pending = run(tool, args, undefined, paint);
    try {
      await viewMatching(views, (view) => view.includes("Reading the"), "the first chunk is on screen", pending);
      push(textFrame("changed files "));
      // A later chunk is not lost: the view grows instead of restarting.
      const accumulated = await viewMatching(
        views,
        (view) => /Reading\s+the\s+changed\s+files/.test(view),
        "both chunks are on screen in order",
        pending,
      );
      expect(accumulated).not.toContain(tail);

      push(progressFrame("full-turn", fullTurn));
      // The full turn arrives whole, and replaces the streamed text rather than doubling it.
      await viewMatching(views, (view) => view.includes(tail), "the full turn's text is on screen", pending);
      for (const snapshot of views) {
        expect(snapshot.split("changed").length - 1).toBeLessThanOrEqual(1);
      }

      push(TERMINAL);
      expect(text(await pending)).toContain("The declared output");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows every turn a node streams before it answers", async () => {
    const streamedChunk = "Reading the diff first";
    const closedTurn = "Reading the changed files, then three findings.";
    const nextTurn = "Writing the report.";
    let push: (frame: string) => void = () => {
      throw new Error("workflow stream did not open");
    };
    const remote = fakeWorkflowFetch({
      stream: (send) => {
        push = send;
        send(DISPATCH + textFrame(streamedChunk));
      },
      read: () => jsonResponse(200, readState({ result: DEFAULT_RESULT })),
    });
    write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
    configure(ws, FAKED_URL);
    vi.stubGlobal("fetch", remote.fetch);
    const tool = executable(await start());
    const args = { workflow: "audit", prompt: "Review changes" };
    const { views, paint } = liveViews(tool, args);

    const pending = run(tool, args, undefined, paint);
    try {
      const streamed = await viewMatching(
        views,
        (view) => view.includes(streamedChunk),
        "the streamed chunk is on screen",
        pending,
      );
      expect(streamed).not.toContain(closedTurn);

      // The producer closes a tool-invoking turn with its full text, then the run goes on: the text
      // it replaces is that turn's chunks, not the whole node's.
      push(progressFrame("assistant-turn", closedTurn) + progressFrame("tool-call"));
      const closed = await viewMatching(
        views,
        (view) => view.includes(closedTurn) && view.includes(RECORDED.toolName),
        "the closed turn and its tool call are on screen",
        pending,
      );
      expect(closed).not.toContain(streamedChunk);
      expect(closed).not.toContain(nextTurn);

      push(progressFrame("text-delta", nextTurn));
      const later = await viewMatching(
        views,
        (view) => view.includes(nextTurn),
        "the turn after the tool is on screen",
        pending,
      );
      // Neither turn is replaced by the next one, and none of them shows twice in one view.
      expect(later).toContain(closedTurn);
      for (const snapshot of views) {
        expect(snapshot.split(nextTurn).length - 1).toBeLessThanOrEqual(1);
        expect(snapshot.split(closedTurn).length - 1).toBeLessThanOrEqual(1);
      }

      push(TERMINAL);
      expect(text(await pending)).toContain("The declared output");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows both turns when a buffered run delivers the same text twice", async () => {
    // The same producer sequence with no chunks at all, rendered by the real call renderer: the two
    // delivered turns are two rows, whatever their wording.
    const turn = "Checking the parser";
    let push: (frame: string) => void = () => {
      throw new Error("workflow stream did not open");
    };
    const remote = fakeWorkflowFetch({
      stream: (send) => {
        push = send;
        send(
          DISPATCH +
            progressFrame("spend") +
            progressFrame("assistant-turn", turn) +
            progressFrame("tool-call") +
            progressFrame("tool-result") +
            progressFrame("spend") +
            progressFrame("assistant-turn", turn),
        );
      },
      read: () => jsonResponse(200, readState({ result: DEFAULT_RESULT })),
    });
    write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
    configure(ws, FAKED_URL);
    vi.stubGlobal("fetch", remote.fetch);
    const tool = executable(await start());
    const args = { workflow: "audit", prompt: "Review changes" };
    const { views, paint } = liveViews(tool, args);
    const rows = (view: string): number => view.split(turn).length - 1;

    const pending = run(tool, args, undefined, paint);
    try {
      const both = await viewMatching(views, (view) => rows(view) === 2, "both delivered turns are on screen", pending);
      expect(both).toContain(RECORDED.toolName);
      for (const snapshot of views) {
        expect(rows(snapshot), "a delivered turn never doubles into extra rows on its own").toBeLessThanOrEqual(2);
      }

      push(TERMINAL);
      expect(text(await pending)).toContain("The declared output");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders deduplicated live updates without thinking", async () => {
    const frames =
      DISPATCH +
      THINKING_MULTILINE +
      progressFrame("thinking-delta", "hidden batched reasoning") +
      textFrame("Visible progress") +
      progressFrame("relay-chunk", "Visible progress") +
      progressFrame("text-delta", "Visible progress") +
      progressFrame("full-turn", "Visible progress") +
      progressFrame("tool-call", "read");
    const remote = await server({ streams: [frames], holdStream: true });
    install(remote);
    const tool = executable(await start());
    expect(tool.renderResult, "Workflow must render its live result").toBeTypeOf("function");
    const args = { workflow: "audit", prompt: "Review changes" };
    const live = deferred<string>();
    const { views, paint } = liveViews(tool, args);

    const pending = run(tool, args, undefined, (update) => {
      const view = paint(update);
      if (view.includes("Visible progress") && view.includes("read")) live.resolve(view);
    });
    await beforeEnd(live.promise, pending, "its live update rendered");
    const view = await live.promise;
    expect(view).toContain("analysis");
    for (const snapshot of views) {
      expect(snapshot.split("Visible progress").length - 1).toBeLessThanOrEqual(1);
      expect(snapshot).not.toContain(RECORDED.thinkingText);
      expect(snapshot).not.toContain("hidden batched reasoning");
    }
    remote.releaseStream();
    expect(text(await pending)).toContain("The declared output");
  });

  it("reconstructs events whose data spans multiple lines", async () => {
    // The endpoint frames raw text one `data:` line per payload line, so a payload carrying a
    // newline arrives split. Rejoining it wrongly loses the tail, fuses the lines, or drops the
    // event whose JSON no longer parses.
    const frames =
      DISPATCH +
      CHUNK_MULTILINE +
      THINKING_MULTILINE +
      // An intermediary may split a JSON payload across `data:` lines: joined with a newline the
      // payload is still valid JSON, so the event must survive and keep its tool line.
      'event: node_progress\ndata: {"node_id":"analysis","step":"tool_call",\ndata:  "detail":{"tool":"read","args":{"path":"src/index.ts"}}}\n\n' +
      TERMINAL;
    const remote = await server({ streams: [frames] });
    install(remote);
    const tool = executable(await start());
    const args = { workflow: "audit", prompt: "Review changes" };
    const { views, paint } = liveViews(tool, args);

    const result = await run(tool, args, undefined, paint);

    expect(text(result)).toContain(RECORDED.answer);
    const all = views.join("\n");
    // Named event split across lines: the rejoined payload parsed, so its tool line is on screen.
    expect(all).toContain("read");
    // Unnamed chunk: both captured lines, in order, with no framing text or empty field leaking in.
    expect(all).toContain(RECORDED.chunkText);
    expect(all).toContain(RECORDED.chunkTail);
    expect(all).not.toContain("data:");
    expect(all).not.toContain(RECORDED.thinkingText);
    expect(all).not.toContain("undefined");
  });

  it("reads CRLF-framed events split across chunk boundaries", async () => {
    // CRLF is an intermediary's framing, not this server's: the producer normalizes CR and CRLF
    // to LF before writing a chunk.
    const chunk = crlf(textFrame("Progress on the run"));
    // The CR ends one chunk and the LF starts the next: a parser that treats a lone CR as a line
    // boundary sees a phantom blank line and loses the frame's terminator.
    const cut = chunk.lastIndexOf("\r");
    let push: (frame: string) => void = () => {
      throw new Error("workflow stream did not open");
    };
    const remote = fakeWorkflowFetch({
      stream: (send) => {
        push = send;
        send(crlf(DISPATCH));
      },
      read: () => jsonResponse(200, readState({ result: DEFAULT_RESULT })),
    });
    write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
    configure(ws, FAKED_URL);
    vi.stubGlobal("fetch", remote.fetch);
    const tool = executable(await start());
    const args = { workflow: "audit", prompt: "Review changes" };
    const { views, paint } = liveViews(tool, args);

    const pending = run(tool, args, undefined, paint);
    try {
      // A CRLF-framed named event parsed: the node's status line is on screen.
      await viewMatching(views, (view) => view.includes("analysis"), "the CRLF-framed dispatch rendered", pending);
      push(chunk.slice(0, cut));
      push(chunk.slice(cut) + crlf(TERMINAL));

      const live = await viewMatching(
        views,
        (view) => view.includes("Progress on the run"),
        "the CRLF-framed text chunk rendered",
        pending,
      );
      expect(live).not.toContain("\r");
      expect(text(await pending)).toContain("The declared output");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rebuilds the live view after a nonterminal disconnect", async () => {
    const remote = await server({
      streams: [DISPATCH + textFrame("old-only text"), DISPATCH + textFrame("new-only text") + TERMINAL],
      states: [
        readState({ status: "running" }),
        readState({
          result: { text: "Final answer", termination_reason: "final_answer", usage: {} },
          // A journal entry this connection never delivered: GET's events array is not a second source.
          events: [{ event: "node_retry", data: { node_id: "never-seen" } }],
        }),
      ],
    });
    install(remote);
    const tool = executable(await start());
    expect(tool.renderResult, "Workflow must render its live result").toBeTypeOf("function");
    const args = { workflow: "audit", prompt: "Review changes" };
    const { views, paint } = liveViews(tool, args);

    const result = await run(tool, args, undefined, paint);

    expect(text(result)).toContain("Final answer");
    expect(views.some((view) => view.includes("old-only text"))).toBe(true);
    expect(views.some((view) => view.includes("new-only text") && !view.includes("old-only text"))).toBe(true);
    expect(views.join("\n")).not.toContain("never-seen");
    const streams = streamRequests(remote);
    expect(streams).toHaveLength(2);
    expect(streams.map((request) => request.lastEventId)).toEqual([undefined, undefined]);
  });

  it("reports the workflow lifecycle through AgentStatus", async () => {
    const remote = await server({ holdStream: true });
    install(remote);
    const capture = await start();
    const tool = executable(capture);
    const pending = run(tool);
    await beforeEnd(remote.streamOpened, pending, "the stream opened");

    const running = await run(executable(capture, "AgentStatus"), {});
    remote.releaseStream();
    await pending;
    const completed = await run(executable(capture, "AgentStatus"), {});

    expect(text(running)).toMatch(/workflow/i);
    expect(text(running)).toContain("audit");
    expect(text(running)).toMatch(/running/i);
    expect(text(completed)).toContain("audit");
    expect(text(completed)).toMatch(/completed/i);
  });

  it("keeps the provenance beside an answer the producer left empty", async () => {
    const remote = await server({
      states: [readState({ result: { text: "", usage: { input_tokens: 5 }, termination_reason: "terminal_tool" } })],
    });
    install(remote);

    const result = await run(executable(await start()));

    expect(text(result)).toContain("empty answer");
    expect(text(result)).toContain("Termination reason: terminal_tool");
  });

  it("uses GET rather than a repeated terminal frame as the result", async () => {
    const remote = await server({
      streams: [TERMINAL, TERMINAL],
      states: [
        readState({ status: "running" }),
        readState({ result: { text: "Authoritative answer", termination_reason: "final_answer", usage: {} } }),
      ],
    });
    install(remote);
    const capture = await start();
    const tool = executable(capture);

    const result = await run(tool);
    const status = await run(executable(capture, "AgentStatus"), {});

    expect(text(result).split("Authoritative answer")).toHaveLength(2);
    expect(text(status).split("audit")).toHaveLength(2);
    expect(streamRequests(remote)).toHaveLength(2);
    expect(readRequests(remote)).toHaveLength(2);
  });

  it("shows one status line per node however often the journal is replayed", async () => {
    // The next connection replays the journal from the start and carries what the run did after the
    // first one ended: the call paints that connection's snapshot whole, never the lines it has
    // seen so far.
    const dispatch = lifecycle("node_dispatched", "analysis");
    const remote = await server({
      streams: [
        `${dispatch}${textFrame("Visible progress")}${TERMINAL}`,
        `${dispatch}${lifecycle("node_complete", "analysis")}${textFrame("Visible progress")}${TERMINAL}`,
      ],
      states: [readState({ status: "running" }), readState({ result: DEFAULT_RESULT })],
    });
    install(remote);
    const tool = executable(await start());
    const args = { workflow: "audit", prompt: "Review changes" };
    const { views, paint } = liveViews(tool, args);

    const result = await run(tool, args, undefined, paint);
    paint(result);

    expect(streamRequests(remote)).toHaveLength(2);
    expect(readRequests(remote)).toHaveLength(2);
    // The node names no other row: the only row naming it is its one status line.
    const statusRows = (view: string): string[] => view.split("\n").filter((row) => row.includes("analysis"));
    for (const view of views) {
      expect(statusRows(view), "the view shows one status line for the node").toHaveLength(1);
      expect(view.split("Visible progress").length - 1, "the view shows the node's text once").toBe(1);
    }
    expect(statusRows(views[0]!)).toEqual(["  \u25b6 analysis dispatched"]);
    expect(views.at(-1)!.split("\n")).toEqual([
      "  \u2713 analysis completed",
      "    Visible progress",
      "  The declared output",
    ]);
    // The replayed lifecycle frame carries the node's stored result: it is not the run's answer.
    expect(views.join("\n")).not.toContain(RECORDED.nodeResult);
    expect(text(result)).toContain("The declared output");
  });
});

describe("workflow run answered by recorded endpoint bytes", () => {
  // Every stream and body in this block is served verbatim out of `recorded/` (no `result:`,
  // `states:` or `rejection:` construction), so a pass means the client read the bytes as the
  // workflow API answers them. `recorded/PROVENANCE.md` says which of them are captured and which
  // are the contract-derived declared-output payload. A recorded body keeps the run id it was taken
  // under, which need not be the id the endpoint handed this run: the client keys on its own create
  // response and reads a body for `status`/`result`/`error` only (ADR-0013), so the mismatch must
  // never be noticed.

  it("returns the declared output the ratified contract puts in GET's result slot", async () => {
    // `declaredOutputRead()` is contract-derived, not captured: no server delivers this body yet, so
    // this pins what the client makes of the shape, never that a server produced it.
    const remote = await server({
      streams: [REPLAY_DECLARED_STREAM],
      reads: [declaredOutputRead()],
    });
    install(remote);
    const tool = executable(await start());

    const result = await run(tool);

    expect(text(result)).toContain(RECORDED.answer);
    // The declared output carries usage and private reasoning: neither belongs in the answer.
    expect(text(result)).not.toContain("input_tokens");
    expect(text(result)).not.toContain("output_tokens");
    expect(text(result)).not.toContain("private chain of thought");
  });

  it("takes its answer from GET, not the terminal frame's copy", async () => {
    // The captured live connection ends with `workflow_engine_finished` whose `result` is the
    // retired marker, while GET answers with the contract-derived declared output: only the GET
    // value may be the answer.
    const remote = await server({
      streams: [DEFAULT_STREAM],
      reads: [declaredOutputRead()],
    });
    install(remote);
    const tool = executable(await start());

    const result = await run(tool);

    expect(text(result)).toContain(RECORDED.answer);
    expect(result.isError ?? false).toBe(false);
  });

  it("answers the captured no-output run with a no-output note", async () => {
    // The captured body carries the fixed key set with `"result": null` next to a completed
    // status, plus a whole journal the client must not read as output.
    const remote = await server({
      run: COMPLETED_RUN,
      streams: [REPLAY_COMPLETED_STREAM],
      reads: [recordedResponse("read-completed-empty-result")],
    });
    install(remote);
    const tool = executable(await start());

    const result = await run(tool);

    expect(text(result)).toMatch(/no.*output/i);
    expect(text(result)).not.toContain(RECORDED.nodeResult);
    expect(text(result)).not.toContain(RECORDED.answer);
  });

  it("raises the terminal-result pre-check on the captured marker body", async () => {
    // What a completed run really answers at the capture revision: the marker, not the output.
    const remote = await server({
      run: COMPLETED_RUN,
      streams: [REPLAY_COMPLETED_STREAM],
      reads: [recordedResponse("read-completed-marker")],
    });
    install(remote);
    const tool = executable(await start());

    const result = await outcome(tool);

    expect(result.isError).toBe(true);
    expect(result.text).toContain(remote.url);
    expect(result.text).toMatch(/result|output/i);
    expect(result.text).not.toContain(RECORDED.nodeResult);
  });

  it("reports a captured failed run across every line of its reason", async () => {
    // The captured terminal frame names the reason `reason`, not `error`, and the GET reason
    // spans two lines.
    const remote = await server({
      streams: [REPLAY_FAILED_STREAM],
      reads: [recordedResponse("read-failed")],
      run: FAILED_RUN,
    });
    install(remote);
    const tool = executable(await start());

    const result = await outcome(tool);

    expect(result.isError).toBe(true);
    expect(result.text).toContain(RECORDED.failureLine);
    expect(result.text).toContain(RECORDED.failureTail);
  });

  it("keeps the configured key out of the reason a failed run answers with", async () => {
    // US-35: the failure reason is GET's own text, so it reaches the call, the record and the log
    // with the endpoint's credential removed.
    const key = "example-private-key";
    const logs = captureConsole();
    const remote = await server({
      streams: [CONTROL_FRAMES],
      states: [readState({ status: "failed", error: `analysis died holding ${key}` })],
    });
    install(remote, key);
    const tool = executable(await start());

    const result = await outcome(tool);

    expect(result.isError).toBe(true);
    expect(result.text).toContain("analysis died holding [redacted]");
    expect(result.text).not.toContain(key);
    expect(logs.join("\n")).not.toContain(key);
    expect(createRequest(remote).authorization).toBe(`Bearer ${key}`);
  });

  it("reports the captured interrupted run as interrupted, never as an answer", async () => {
    // The replayed journal ends in `workflow_engine_finished` while GET says `interrupted`: the
    // close and the in-stream terminal event settle nothing, only the GET answer decides.
    const remote = await server({
      run: COMPLETED_RUN,
      streams: [REPLAY_COMPLETED_STREAM],
      reads: [recordedResponse("read-interrupted")],
    });
    install(remote);
    const tool = executable(await start());

    const result = await outcome(tool);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/interrupt/i);
    expect(result.text).not.toContain(RECORDED.answer);
  });

  it("reports the captured journal-less known run as interrupted, never as missing", async () => {
    // The no-404 startup window: a known task whose journal has not been written answers 200 with
    // `interrupted` and an empty `events` array.
    const remote = await server({
      streams: [CONTROL_FRAMES],
      reads: [recordedResponse("read-known-no-log")],
    });
    install(remote);
    const tool = executable(await start());

    const result = await outcome(tool);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/interrupt/i);
    expect(result.text).not.toMatch(/not found|unknown workflow/i);
  });

  it("keeps a captured running answer from settling the run", async () => {
    // `running` is not a terminal state, so the captured close plus the captured running answer
    // must reopen the stream and keep watching rather than returning a result or a label.
    write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
    configure(ws, FAKED_URL);
    const capture = await start();
    const tool = executable(capture);
    const firstRead = deferred<void>();
    const remote = fakeWorkflowFetch({
      stream: (push, close) => {
        push(RECONNECT);
        close();
      },
      read: () => {
        firstRead.resolve();
        return recordedRead("read-running");
      },
    });
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", remote.fetch);
    try {
      let settled = false;
      const pending = outcome(tool).then((finished) => {
        settled = true;
        return finished;
      });
      await beforeEnd(firstRead.promise, pending, "the first state read");
      await vi.advanceTimersByTimeAsync(0);
      const opened = remote.requests().filter((request) => request.url.endsWith("/stream")).length;
      await pump(9, 10_000);
      const status = await run(executable(capture, "AgentStatus"), {});

      expect(settled, "a captured running answer must not settle the run").toBe(false);
      expect(remote.reads()).toBeGreaterThanOrEqual(1);
      expect(remote.requests().filter((request) => request.url.endsWith("/stream")).length).toBeGreaterThan(opened);
      expect(text(status)).toContain("audit");
      expect(text(status)).toMatch(/running/i);
      expect(text(status)).not.toMatch(/completed|failed|stopped/i);

      await shutdownSession(capture);
      expect((await pending).text).toMatch(/shutdown|session/i);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  for (const name of ["create-missing-prompt", "create-prompt-too-long", "create-config-not-object"]) {
    it(`surfaces the captured ${name.replace("create-", "")} rejection as the server states it`, async () => {
      const remote = await server({ rejection: recordedResponse(name) });
      install(remote);
      const tool = executable(await start());

      const result = await outcome(tool);

      const stated = JSON.parse(recordedResponse(name).body) as { error: string };
      expect(result.isError).toBe(true);
      expect(result.text).toContain(stated.error);
      expect(result.text).toContain(remote.url);
    });
  }

  it("keeps a run whose state read is refused running, and gives the caller no endpoint reason", async () => {
    // A refused read carries no run status, so it hands the call back as unknown (US-19) instead of
    // settling the run: StopAgent still reaches the endpoint afterwards.
    const key = "example-private-key";
    const logs = captureConsole();
    const firstRead = deferred<void>();
    const remote = fakeWorkflowFetch({
      stream: (_push, close) => close(),
      read: () => {
        firstRead.resolve();
        return recordedRead("read-unauthorized");
      },
    });
    write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
    configure(ws, FAKED_URL, key);
    const capture = await start();
    const tool = executable(capture);
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", remote.fetch);
    try {
      const pending = outcome(tool);
      await beforeEnd(firstRead.promise, pending, "the first state read");
      await pump(16, 20_000);
      const result = await pending;

      expect(result.isError).toBe(false);
      expect(result.text).toMatch(/state is unknown after 5 observations/i);
      expect(result.text, "what failed is a read, not the run: its reason is not the caller's to see").not.toContain(
        "Unauthorized",
      );
      expect(result.text).not.toContain(key);
      expect(logs.join("\n")).not.toContain(key);
      expect(remote.requests()[0]!.authorization).toBe(`Bearer ${key}`);

      const status = await run(executable(capture, "AgentStatus"), {});
      expect(text(status)).toContain("audit");
      expect(text(status)).toMatch(/running/i);
      // The live note says out loud that nothing was stopped; only the row's status slot may not claim one.
      expect(text(status)).not.toMatch(/\)\s+(stopped|error|completed|failed)\b/);

      const stopped = await outcome(executable(capture, "StopAgent"), { agent_id: listedRunId(status) });
      expect(stopped.isError).toBe(false);
      expect(remote.requests().filter((request) => request.url.endsWith("/stop"))).toHaveLength(1);
    } finally {
      await shutdownSession(capture);
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("workflow selection", () => {
  it("registers the Workflow tool with its public parameters", async () => {
    write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
    const api = await start();

    expect(workflowTool(api)).toMatchObject({
      name: "Workflow",
      parameters: {
        properties: {
          workflow: expect.objectContaining({ type: "string" }),
          prompt: expect.objectContaining({ type: "string" }),
          path: expect.objectContaining({ type: "string" }),
          run_in_background: expect.objectContaining({ type: "boolean" }),
        },
      },
    });
    expect(workflowTool(api)?.description).toMatch(/workflow/i);
    expect(workflowTool(api)?.parameters.required?.slice().sort()).toEqual(["prompt", "workflow"]);
    expect(Object.keys(workflowTool(api)!.parameters.properties).sort()).toEqual([
      "path",
      "prompt",
      "run_in_background",
      "workflow",
    ]);
  });

  it("lists each discovered workflow for selection", async () => {
    write(join(ws.agentDir, "workflows", "audit.yaml"), workflow("audit", "Inspect repository changes"));
    write(join(ws.project, ".agents", "workflows", "release.yml"), workflow("release-review", "Review a release"));
    write(join(ws.project, ".pi", "workflows", "security.yaml"), workflow("security-review", "Examine security"));
    const description = selectionDescription(await start());

    for (const needle of [
      "audit",
      "Inspect repository changes",
      "release-review",
      "Review a release",
      "security-review",
      "Examine security",
    ]) {
      expect(description).toContain(needle);
    }
  });

  it("uses the project description when definitions share a name", async () => {
    write(join(ws.agentDir, "workflows", "audit.yaml"), workflow("audit", "Global audit"));
    write(join(ws.project, ".agents", "workflows", "audit.yml"), workflow("audit", "Shared audit"));
    write(join(ws.project, ".pi", "workflows", "audit.yaml"), workflow("audit", "Project audit"));
    const description = selectionDescription(await start());

    expect(description).toContain("Project audit");
    expect(description).not.toContain("Global audit");
    expect(description).not.toContain("Shared audit");
  });

  it("prefers the shared definition over the global one", async () => {
    write(join(ws.agentDir, "workflows", "audit.yaml"), workflow("audit", "Global audit"));
    write(join(ws.project, ".agents", "workflows", "audit.yml"), workflow("audit", "Shared audit"));
    const description = selectionDescription(await start());

    expect(description).toContain("Shared audit");
    expect(description).not.toContain("Global audit");
  });

  it("sends only the winning file when definitions collide by name", async () => {
    const remote = await server();
    configure(ws, remote.url);
    write(
      join(ws.agentDir, "workflows", "audit.yaml"),
      `${workflow("audit", "Global audit", "global-node")}owner: global\n`,
    );
    write(
      join(ws.project, ".agents", "workflows", "audit.yml"),
      `${workflow("audit", "Shared audit", "shared-node")}owner: shared\n`,
    );
    const tool = executable(await start());

    await run(tool, { workflow: "audit", prompt: "Review changes" });

    // US-2 replaces the whole file: the losing definition contributes no node, no entry point,
    // and not even a key the winner omits.
    expect(JSON.parse(createRequest(remote).body).workflow_config).toEqual({
      name: "audit",
      description: "Shared audit",
      nodes: [{ id: "shared-node", params: { task_description: "{{task_description}}" } }],
      edges: [],
      entry_node: "shared-node",
      owner: "shared",
      prompt_vars: { working_dir: ws.project },
    });
  });

  it("omits project and shared workflows from an untrusted project's selection", async () => {
    write(join(ws.agentDir, "workflows", "global.yaml"), workflow("global-review", "Safe global workflow"));
    write(join(ws.project, ".agents", "workflows", "shared.yml"), workflow("shared-review", "Shared workflow"));
    write(join(ws.project, ".pi", "workflows", "project.yaml"), workflow("project-review", "Project workflow"));
    const description = selectionDescription(await start(false));

    expect(description).toContain("global-review");
    expect(description).not.toContain("shared-review");
    expect(description).not.toContain("project-review");
  });

  it("selects the later alphabetical file when names collide in one folder", async () => {
    const dir = join(ws.agentDir, "workflows");
    write(join(dir, "a-audit.yaml"), workflow("audit", "Earlier definition"));
    write(join(dir, "z-audit.yml"), workflow("audit", "Later definition"));
    const description = selectionDescription(await start());

    expect(description).toContain("Later definition");
    expect(description).not.toContain("Earlier definition");
  });

  it("discovers a workflow added after the session started", async () => {
    const remote = await server();
    install(remote);
    const capture = await start();
    const tool = executable(capture);
    write(
      join(ws.agentDir, "workflows", "release.yml"),
      workflow("release-review", "Review a release", "release-node"),
    );

    const result = await run(tool, { workflow: "release-review", prompt: "Review release" });

    expect(text(result)).toContain("The declared output");
    expect(JSON.parse(createRequest(remote).body).workflow_config.name).toBe("release-review");
    expect(selectionDescription(capture)).toContain("Review a release");
  });

  it("re-reads a known workflow from disk for the next run", async () => {
    const first = await server();
    const second = await server();
    write(
      join(ws.agentDir, "subagents-lite.json"),
      JSON.stringify({
        workflows: { endpoints: { first: { url: first.url }, second: { url: second.url } }, defaultEndpoint: "first" },
      }),
    );
    const file = join(ws.agentDir, "workflows", "audit.yaml");
    write(file, `${workflow("audit", "First definition", "first-node")}endpoint: first\n`);
    const tool = executable(await start());

    await run(tool, { workflow: "audit", prompt: "First run" });
    write(file, `${workflow("audit", "Second definition", "second-node")}endpoint: second\n`);
    await run(tool, { workflow: "audit", prompt: "Second run" });

    expect(JSON.parse(createRequest(first).body).workflow_config.entry_node).toBe("first-node");
    expect(JSON.parse(createRequest(second).body).workflow_config.entry_node).toBe("second-node");
  });

  it("drops a workflow name once its file stops declaring it", async () => {
    const remote = await server();
    configure(ws, remote.url);
    const file = join(ws.agentDir, "workflows", "audit.yaml");
    write(file, workflow());
    const tool = executable(await start());
    write(file, workflow("renamed-audit", "Inspect a repository"));

    const result = await outcome(tool, { workflow: "audit", prompt: "Review changes" });

    expect(result.isError).toBe(true);
    // The rescan, not the stale session-start listing, answers: only it knows the new name.
    expect(result.text).toContain("renamed-audit");
    expect(remote.requests).toEqual([]);
  });

  it("warns when same-folder workflow names collide", async () => {
    const dir = join(ws.agentDir, "workflows");
    write(join(dir, "a-audit.yaml"), workflow("audit", "Earlier definition"));
    write(join(dir, "z-audit.yml"), workflow("audit", "Later definition"));
    const warnings: string[] = [];

    await start(true, warnings);
    const messages = warnings.join("\n");

    expect(messages).toMatch(/duplicate|collision|conflict/i);
    expect(messages).toContain("audit");
  });

  it("warns when a workflow file cannot be parsed", async () => {
    const dir = join(ws.agentDir, "workflows");
    write(join(dir, "bad-workflow.yaml"), "name: [unterminated\n");
    write(join(dir, "valid.yml"), workflow("valid-review", "Valid workflow"));
    const warnings: string[] = [];

    await start(true, warnings);

    expect(warnings.join("\n")).toContain("bad-workflow.yaml");
  });

  it("warns about every workflow file it skips for an invalid name", async () => {
    const dir = join(ws.agentDir, "workflows");
    write(join(dir, "missing.yaml"), "description: Missing a name\nnodes: []\nedges: []\n");
    write(join(dir, "empty.yaml"), 'name: ""\ndescription: Empty name\n');
    write(join(dir, "number.yaml"), "name: 42\ndescription: Numeric name\n");
    const warnings: string[] = [];

    await start(true, warnings);

    // US-33: a skipped file is announced by name, never dropped in silence.
    const messages = warnings.join("\n");
    expect(messages).toContain("missing.yaml");
    expect(messages).toContain("empty.yaml");
    expect(messages).toContain("number.yaml");
  });

  it("keeps valid workflows selectable when other files are invalid", async () => {
    const dir = join(ws.agentDir, "workflows");
    write(join(dir, "valid.yml"), workflow("valid-review", "Valid workflow"));
    write(join(dir, "malformed.yaml"), "name: [unterminated\n");
    write(join(dir, "missing.yaml"), "description: Missing a name\nnodes: []\nedges: []\n");
    write(join(dir, "empty.yaml"), 'name: ""\ndescription: Empty name\n');
    write(join(dir, "number.yaml"), "name: 42\ndescription: Numeric name\n");
    const description = selectionDescription(await start());

    expect(description).toContain("valid-review");
    expect(description).not.toContain("Missing a name");
    expect(description).not.toContain("Empty name");
    expect(description).not.toContain("Numeric name");
  });
});

describe("workflow endpoint and input errors", () => {
  for (const trusted of [true, false]) {
    it(`applies a project URL override only when trusted (${trusted})`, async () => {
      const globalEndpoint = await server();
      const projectEndpoint = await server();
      install(globalEndpoint, "global-key");
      write(
        join(ws.project, ".pi", "subagents-lite.json"),
        JSON.stringify({ workflows: { endpoints: { local: { url: projectEndpoint.url, apiKey: "project-key" } } } }),
      );
      const tool = executable(await start(trusted));

      const result = await run(tool);

      expect(text(result)).toContain("The declared output");
      const chosen = trusted ? projectEndpoint : globalEndpoint;
      const other = trusted ? globalEndpoint : projectEndpoint;
      expect(createRequest(chosen).authorization).toBe("Bearer global-key");
      expect(other.requests).toEqual([]);
    });
  }

  it("lists available workflow names after a miss", async () => {
    const remote = await server();
    install(remote);
    write(join(ws.agentDir, "workflows", "release.yml"), workflow("release-review", "Review a release"));
    const tool = executable(await start());

    const result = await outcome(tool, { workflow: "audti", prompt: "Review changes" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("audit");
    expect(result.text).toContain("release-review");
    expect(remote.requests).toEqual([]);
  });

  for (const [label, prompt, error] of [
    ["empty", "", /prompt/i],
    ["over the byte cap", "é".repeat(5001), /10.?000|10000/],
  ] as const) {
    it(`rejects an ${label} prompt before contacting the endpoint`, async () => {
      const remote = await server();
      install(remote);
      const tool = executable(await start());

      const result = await outcome(tool, { workflow: "audit", prompt });

      expect(result.isError).toBe(true);
      expect(result.text).toMatch(error);
      expect(remote.requests).toEqual([]);
    });
  }

  it("accepts a prompt at the UTF-8 byte limit", async () => {
    const remote = await server();
    install(remote);
    const tool = executable(await start());
    const prompt = "é".repeat(5000);

    const result = await run(tool, { workflow: "audit", prompt });

    expect(text(result)).toContain("The declared output");
    expect(JSON.parse(createRequest(remote).body).prompt).toBe(prompt);
  });

  it("identifies unreachable endpoints for troubleshooting", async () => {
    const dead = await server();
    const live = await server();
    await dead.close();
    write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
    write(
      join(ws.agentDir, "subagents-lite.json"),
      JSON.stringify({
        workflows: { endpoints: { local: { url: dead.url }, release: { url: live.url } }, defaultEndpoint: "local" },
      }),
    );
    const tool = executable(await start());

    const result = await outcome(tool);

    expect(result.isError).toBe(true);
    expect(result.text).toContain(dead.url);
    // US-21: the fix is a key choice, so the keys the configuration offers are named - and none of
    // them is contacted on its own.
    expect(result.text).toMatch(/configured endpoints/i);
    expect(result.text).toContain("release");
    expect(live.requests).toEqual([]);
  });

  for (const status of [422, 404, 503]) {
    it(`surfaces a ${status} server rejection without leaking its key`, async () => {
      const key = "example-private-key";
      const logs = captureConsole();
      const remote = await server({
        rejection: { status, body: errorBody(`Remote validation failed; credential ${key}`) },
      });
      install(remote, key);
      const tool = executable(await start());

      const result = await outcome(tool);

      expect(result.isError).toBe(true);
      expect(result.text).toContain("Remote validation failed");
      // US-8/US-35: the key stays out of the transcript and out of the logs alike.
      expect(result.text).not.toContain(key);
      expect(logs.join("\n")).not.toContain(key);
      expect(createRequest(remote).authorization).toBe(`Bearer ${key}`);
    });
  }

  it("rejects a workflow's unknown endpoint without falling back", async () => {
    const remote = await server();
    write(join(ws.agentDir, "workflows", "audit.yaml"), `${workflow()}endpoint: missing-target\n`);
    configure(ws, remote.url);
    const tool = executable(await start());

    const result = await outcome(tool);

    expect(result.isError).toBe(true);
    expect(result.text).toContain("missing-target");
    expect(remote.requests).toEqual([]);
  });

  for (const scenario of ["unknown-default", "invalid-url"] as const) {
    it(`rejects an ${scenario} endpoint without contacting another server`, async () => {
      const remote = await server();
      write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
      const offender = scenario === "unknown-default" ? "missing-default" : "invalid";
      write(
        join(ws.agentDir, "subagents-lite.json"),
        JSON.stringify({
          workflows: {
            endpoints:
              scenario === "unknown-default"
                ? { local: { url: remote.url } }
                : { local: { url: remote.url }, invalid: { url: "not a valid URL" } },
            defaultEndpoint: scenario === "unknown-default" ? "missing-default" : "invalid",
          },
        }),
      );
      const tool = executable(await start());

      const result = await outcome(tool);

      expect(result.isError).toBe(true);
      expect(result.text).toContain(offender);
      if (scenario === "invalid-url") {
        expect(result.text).toContain("workflows.endpoints[invalid].url");
        expect(result.text).not.toContain("not a valid URL");
      }
      expect(remote.requests).toEqual([]);
    });
  }

  it("does not send credentials across an endpoint redirect", async () => {
    const logs = captureConsole();
    const other = await server();
    const remote = await server({ redirect: `${other.url}/api/workflows` });
    install(remote, "redirect-key");
    const tool = executable(await start());

    const result = await outcome(tool);

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("redirect-key");
    expect(logs.join("\n")).not.toContain("redirect-key");
    expect(other.requests).toEqual([]);
  });

  it("reports a lost create response as an unknown outcome without retrying", async () => {
    const remote = await server({ loseCreateResponse: true });
    install(remote);
    const tool = executable(await start());

    const result = await outcome(tool);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/unknown|possibly|may still/i);
    expect(createRequests(remote)).toHaveLength(1);
  });
});

describe("workflow cancellation and shutdown", () => {
  it("sends no request for an already interrupted call", async () => {
    const remote = await server();
    install(remote);
    const tool = executable(await start());
    const abort = new AbortController();
    abort.abort();

    const result = await outcome(tool, { workflow: "audit", prompt: "Review changes" }, abort.signal);

    expect(result.text).toMatch(/cancel|abort|interrupt/i);
    expect(remote.requests).toEqual([]);
  });

  it("stops a foreground run when interrupted", async () => {
    const remote = await server({ holdStream: true });
    install(remote);
    const tool = executable(await start());
    const abort = new AbortController();
    const pending = outcome(tool, { workflow: "audit", prompt: "Review changes" }, abort.signal);
    await beforeEnd(remote.streamOpened, pending, "the stream opened");

    abort.abort();
    await remote.stopReceived;
    const result = await pending;

    expect(result.text).toMatch(/stopp|abort|interrupt|cancel/i);
    expect(stopRequests(remote)).toHaveLength(1);
  });

  it("stops a run whose create response arrives after interruption", async () => {
    const remote = await server({ holdCreate: true, holdStream: true });
    install(remote);
    const tool = executable(await start());
    const abort = new AbortController();
    const pending = outcome(tool, { workflow: "audit", prompt: "Review changes" }, abort.signal);
    await beforeEnd(remote.createReceived, pending, "create was sent");

    abort.abort();
    remote.releaseCreate();
    await remote.stopReceived;
    await pending;

    expect(createRequests(remote)).toHaveLength(1);
    expect(stopRequests(remote)).toHaveLength(1);
  });

  it("leaves a run whose create answer arrived after shutdown unwatched and unstopped", async () => {
    const remote = await server({ holdCreate: true, holdStream: true });
    install(remote);
    const capture = await start();
    const tool = executable(capture);

    const pending = run(tool);
    await beforeEnd(remote.createReceived, pending, "create was sent");

    await shutdownSession(capture);
    remote.releaseCreate();
    const result = await pending;

    // US-30: the late answer registers no record, opens no follow, and stops nothing remotely.
    expect(text(result)).toMatch(/shut ?down|session/i);
    expect(result.details.agentId, "the run left no record behind").toBeUndefined();
    expect(stopRequests(remote)).toHaveLength(0);
    expect(streamRequests(remote), "a run nobody owns is never followed").toHaveLength(0);
  });

  it("keeps an acknowledged stop despite the remote terminated footprint", async () => {
    const remote = await server({ holdStream: true });
    install(remote);
    const capture = await start();
    const tool = executable(capture);
    expect(tool.renderResult, "Workflow must render its live result").toBeTypeOf("function");
    const args = { workflow: "audit", prompt: "Review changes" };
    const live = deferred<string>();
    const invalidated = deferred<string>();
    const abort = new AbortController();
    const state: Record<string, unknown> = {};
    let interruptRequested = false;
    let lastUpdate: WorkflowResult | undefined;
    function paint(update: WorkflowResult): string {
      lastUpdate = update;
      const view = resultView(tool, update, args, {
        state,
        invalidate: () => {
          if (lastUpdate) paint(lastUpdate);
        },
      });
      if (interruptRequested && /stopped/i.test(view)) invalidated.resolve(view);
      return view;
    }
    const pending = run(tool, args, abort.signal, (update) => {
      const view = paint(update);
      if (view.includes("Inspecting the repository")) live.resolve(view);
    }).then(
      (result) => text(result),
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await beforeEnd(live.promise, pending, "its live update rendered");
    const partial = await live.promise;

    interruptRequested = true;
    abort.abort();
    await remote.stopReceived;
    const stoppedView = await invalidated.promise;
    await pending;

    const remoteState = await (await fetch(`${remote.url}/api/workflows/${REMOTE_ID}`)).json();
    expect(remoteState.status).toBe("failed");
    expect(remoteState.error).toBe("terminated");
    const status = await run(executable(capture, "AgentStatus"), {});
    expect(text(status)).toContain("audit");
    expect(text(status)).toMatch(/stopped/i);
    expect(text(status)).not.toMatch(/\berror\b/i);
    expect(partial).toContain("Inspecting the repository");
    expect(stoppedView).toContain("Inspecting the repository");
  });

  it("settles an already-finished stop from GET rather than a stopped label", async () => {
    // The stop reaches the endpoint after the run's terminal event was journaled, so the ack is
    // `already_finished` and only GET carries the terminal state. The original held stream
    // never delivered a terminal frame, and only an acknowledged `stopped` outranks GET (US-18).
    const remote = await server({
      holdStream: true,
      stopOutcome: "already_finished",
      streams: [DISPATCH, TERMINAL],
      reads: [stateReply({ status: "failed", error: "Runner lost its lease" })],
    });
    install(remote);
    const capture = await start();
    const abort = new AbortController();
    const pending = outcome(executable(capture), { workflow: "audit", prompt: "Review changes" }, abort.signal);
    await beforeEnd(remote.streamOpened, pending, "the stream opened");

    abort.abort();
    await remote.stopReceived;
    await pending;

    // Count the client's GET; reading the fixture's scripted reply would prove only the fixture.
    expect(readRequests(remote)).toHaveLength(1);
    expect(stopRequests(remote)).toHaveLength(1);

    const status = await run(executable(capture, "AgentStatus"), {});
    expect(text(status)).toContain("audit");
    // failed maps to error (US-18): neither the killed-run label nor an invented completion.
    expect(text(status)).toMatch(/error/i);
    expect(text(status)).not.toMatch(/stopped|running/i);
  });

  it("reports an honest unknown outcome when the endpoint refuses the stop", async () => {
    // The captured refusal is the endpoint's own 404 body: a stop the endpoint did not
    // acknowledge says nothing about the run.
    const remote = await server({ holdStream: true, stopRejection: recordedResponse("stop-unknown") });
    install(remote);
    const capture = await start();
    const tool = executable(capture);
    const abort = new AbortController();
    const pending = outcome(tool, { workflow: "audit", prompt: "Review changes" }, abort.signal);
    await beforeEnd(remote.streamOpened, pending, "the stream opened");

    abort.abort();
    await remote.stopReceived;
    const stopped = await pending;
    const status = await run(executable(capture, "AgentStatus"), {});

    // US-27: a stop that failed is reported as failed, with the state the endpoint confirmed,
    // and the run keeps its running record for a manual retry.
    const report = `${stopped.text}\n${text(status)}`;
    expect(report).toMatch(/stop failed/i);
    expect(report, "a refused stop claims the state the endpoint confirmed, not an unknown state").not.toMatch(
      /unknown/i,
    );
    expect(text(status)).toContain("audit");
    expect(text(status)).toMatch(/running/i);
    // The note quotes the endpoint's refusal out loud; only the row's status slot may not claim an outcome.
    expect(text(status)).not.toMatch(/\)\s+(stopped|error|completed|failed)\b/);
    expect(stopRequests(remote)).toHaveLength(1);
  });

  it("ends local observation on shutdown alone, with no stop request of its own", async () => {
    let push: (frame: string) => void = () => {
      throw new Error("workflow stream did not open");
    };
    const remote = fakeWorkflowFetch({
      stream: (send) => {
        push = send;
        send(DISPATCH);
      },
      read: () => jsonResponse(200, readState({ status: "running" })),
    });
    write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
    configure(ws, FAKED_URL);
    const notices: string[] = [];
    const capture = await start(true, notices);
    const tool = executable(capture);
    const args = { workflow: "audit", prompt: "Review changes" };
    const { views, paint } = liveViews(tool, args);
    const shown = deferred<void>();
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", remote.fetch);
    try {
      const pending = run(tool, args, undefined, (update) => {
        paint(update);
        if (views.length === 1) shown.resolve();
      }).then(
        (result) => text(result),
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      await beforeEnd(shown.promise, pending, "the first live view rendered");

      await shutdownSession(capture);
      const report = await pending;
      const atShutdown = remote.requests();
      const viewsAtShutdown = views.length;

      // US-30: a shutdown that carried no abort ends observation. A pushed frame and minutes of
      // retry time change nothing, and this path sends no stop: a teardown that aborts the active
      // turn first stops the run through that abort, which `shared-boundaries.test.ts` pins.
      try {
        push("data: text after shutdown\n\n");
      } catch {
        /* the connection was already closed locally - nothing can arrive either */
      }
      await vi.advanceTimersByTimeAsync(300_000);

      expect(report).toMatch(/shutdown|session/i);
      // A reload ends observation. It says nothing about the remote outcome.
      expect(notices.join("\n")).toMatch(/no longer watched.*unknown/i);
      expect(notices.join("\n")).not.toMatch(/killed|nothing was stopped|left running remotely/i);
      expect(remote.requests()).toEqual(atShutdown);
      expect(views).toHaveLength(viewsAtShutdown);
      expect(views.join("\n")).not.toContain("text after shutdown");
      expect(atShutdown.filter((request) => request.url.endsWith("/stop"))).toEqual([]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("workflow runs on the shared management surfaces", () => {
  it("stops a workflow run through StopAgent", async () => {
    const remote = await server({ holdStream: true });
    install(remote);
    const capture = await start();
    const pending = outcome(executable(capture));
    await beforeEnd(remote.streamOpened, pending, "the stream opened");
    const id = listedRunId(await run(executable(capture, "AgentStatus"), {}));

    const stop = await outcome(executable(capture, "StopAgent"), { agent_id: id });
    await remote.stopReceived;
    const result = await pending;
    const status = await run(executable(capture, "AgentStatus"), {});

    expect(stop.isError).toBe(false);
    expect(stopRequests(remote)).toHaveLength(1);
    // US-18 precedence: the acknowledged stop outranks the endpoint's terminated footprint.
    expect(text(status)).toContain("audit");
    expect(text(status)).toMatch(/stopped/i);
    expect(text(status)).not.toMatch(/\berror\b/i);
    expect(result.text).toMatch(/stopp|abort|interrupt|cancel/i);

    // Settled, and still not an agent: the run is named as what it is.
    const again = await outcome(executable(capture, "StopAgent"), { agent_id: id });
    expect(again.text).toMatch(/workflow run \w+ is already stopped/i);
  });

  it("refuses to message a workflow run", async () => {
    const remote = await server({ holdStream: true });
    install(remote);
    const capture = await start();
    const pending = outcome(executable(capture));
    await beforeEnd(remote.streamOpened, pending, "the stream opened");
    const id = listedRunId(await run(executable(capture, "AgentStatus"), {}));

    const result = await outcome(executable(capture, "MessageAgent"), { agent_id: id, message: "Focus on tests" });
    remote.releaseStream();
    await pending;

    // US-29: no steering API exists, so the call is refused, never buffered or confirmed.
    expect(result.isError).toBe(true);
    expect(result.text).not.toMatch(/\bsent\b/i);
    expect(result.text).toMatch(/workflow|steer|unsupported|not support/i);
  });

  it("offers a workflow run no menu action it cannot perform", async () => {
    const remote = await server({ holdStream: true });
    install(remote);
    const capture = await start();
    const pending = outcome(executable(capture));
    await beforeEnd(remote.streamOpened, pending, "the stream opened");
    const list = await openRunningAgents(capture);

    list.handleInput?.("\r");
    const actions = rendered(list);
    const rows = actions
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    remote.releaseStream();
    await pending;

    // The run row (id and all) is gone: what is rendered is the action set, not the run list.
    expect(rows.some((row) => /[0-9a-f]{8}/.test(row))).toBe(false);
    // US-29: nothing can be steered and no Pi transcript exists, so neither is offered.
    expect(rows.some((row) => /(?:^|\s)Stop$/.test(row))).toBe(true);
    expect(actions).not.toMatch(/steer/i);
    expect(actions).not.toMatch(/view (snapshot|conversation|result|error)/i);
  });

  it("shows the workflow run as a workflow in the running-agents menu", async () => {
    const remote = await server({ holdStream: true });
    install(remote);
    const capture = await start();
    const pending = outcome(executable(capture));
    await beforeEnd(remote.streamOpened, pending, "the stream opened");

    const rows = rendered(await openRunningAgents(capture));
    remote.releaseStream();
    await pending;

    expect(rows).toContain("audit");
    expect(rows).toMatch(/workflow/i);
  });

  it("states the delivery rule for a workflow run without promising it a notification", async () => {
    const remote = await server({ holdStream: true });
    install(remote);
    const capture = await start();
    const pending = outcome(executable(capture));
    await beforeEnd(remote.streamOpened, pending, "the stream opened");

    const status = await run(executable(capture, "AgentStatus"), {});
    remote.releaseStream();
    await pending;

    // Wave 2 delivers a Nudge for a workflow run too, so the line states one rule for every kind and
    // promises this run nothing.
    expect(text(status)).toContain("audit");
    expect(text(status)).toMatch(/Don't poll/);
    expect(text(status)).not.toMatch(/you.ll (receive|get|be told)/i);
  });
});

describe("workflow monitoring degradation", () => {
  it("leaves a handed-back run alone when the parent interrupt arrives later", async () => {
    // US-19/US-30: the call handed the run back; an interrupt of that call afterwards is not a stop
    // request, and the record keeps watching.
    write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
    configure(ws, FAKED_URL);
    const capture = await start();
    const tool = executable(capture);
    const abort = new AbortController();
    const firstRead = deferred<void>();
    const remote = fakeWorkflowFetch({
      stream: (_push, close) => close(),
      read: () => {
        firstRead.resolve();
        return jsonResponse(503, { error: "Temporarily unavailable" });
      },
    });
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", remote.fetch);
    const stops = () => remote.requests().filter((request) => request.url.endsWith("/stop"));
    try {
      const pending = run(tool, undefined, abort.signal);
      await beforeEnd(firstRead.promise, pending, "the first state read");
      await pump(16, 20_000);

      const result = await pending;
      abort.abort();
      await pump(4, 20_000);

      expect(result.isError ?? false).toBe(false);
      expect(stops(), "a run the call handed back is no longer the caller's to stop").toEqual([]);
      const status = await run(executable(capture, "AgentStatus"), {});
      expect(text(status)).toContain("audit");
      expect(text(status)).toMatch(/running/i);
      expect(text(status)).not.toMatch(/\)\s+(stopped|error|completed|failed)\b/);
    } finally {
      await shutdownSession(capture);
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("leaves a run handed back on a refused stop alone when the parent interrupt arrives later", async () => {
    // US-27 then US-19/US-30: the stop the endpoint refused hands the call back with the run still
    // remote, and the interrupt of that same call afterwards is not a second stop request.
    write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
    configure(ws, FAKED_URL);
    const capture = await start();
    const tool = executable(capture);
    const abort = new AbortController();
    const streamOpened = deferred<void>();
    let acknowledged = false;
    const remote = fakeWorkflowFetch({
      stream: () => streamOpened.resolve(),
      read: () => jsonResponse(200, readState({ status: "running" })),
      stop: () =>
        acknowledged
          ? jsonResponse(200, stopAck("stopped", REMOTE_ID))
          : jsonResponse(503, errorBody("Service Unavailable")),
    });
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", remote.fetch);
    const stops = () => remote.requests().filter((request) => request.url.endsWith("/stop"));
    try {
      const pending = run(tool, undefined, abort.signal);
      await beforeEnd(streamOpened.promise, pending, "the run's stream connection");
      const id = listedRunId(await run(executable(capture, "AgentStatus"), {}));

      const requested = await outcome(executable(capture, "StopAgent"), { agent_id: id });
      await pump(4, 5_000);
      const returned = await pending;

      expect(requested.isError ?? false).toBe(false);
      expect(text(returned)).toMatch(/stop failed/i);
      expect(text(returned), "a refused stop claims no unknown state").not.toMatch(/unknown/i);
      expect(stops(), "the refused stop was asked for once").toHaveLength(1);

      abort.abort();
      await pump(4, 20_000);

      expect(stops(), "a run the call handed back is no longer the caller's to stop").toHaveLength(1);
      expect(text(await run(executable(capture, "AgentStatus"), {}))).toMatch(/running/i);

      acknowledged = true;
      await outcome(executable(capture, "StopAgent"), { agent_id: id });
      await pump(4, 20_000);

      expect(stops(), "the explicit stop retry still reaches the endpoint").toHaveLength(2);
      expect(text(await run(executable(capture, "AgentStatus"), {}))).toMatch(/stopped/i);
    } finally {
      await shutdownSession(capture);
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("reconciles after lifecycle silence despite pings and streamed text", async () => {
    write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
    configure(ws, FAKED_URL);
    const capture = await start();
    const tool = executable(capture);
    expect(tool.renderResult, "Workflow must render its live result").toBeTypeOf("function");
    const args = { workflow: "audit", prompt: "Review changes" };
    const { paint } = liveViews(tool, args);
    const dispatched = deferred<void>();
    let push: (frame: string) => void = () => {
      throw new Error("workflow stream did not open");
    };
    const remote = fakeWorkflowFetch({
      stream: (send) => {
        push = send;
        send(DISPATCH);
      },
      read: () =>
        jsonResponse(
          200,
          readState({
            result: { text: "Silence-reconciled answer", usage: {}, termination_reason: "final_answer" },
          }),
        ),
    });
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", remote.fetch);
    try {
      const pending = run(tool, args, undefined, (update) => {
        if (paint(update).includes("analysis")) dispatched.resolve();
      });
      await beforeEnd(dispatched.promise, pending, "node dispatch rendered");

      // The silence window is counted in lifecycle events only. Advancing to exactly the
      // window's length is what makes a ping or a text chunk resetting it observable: such
      // a reset leaves the deadline unreached and the call hanging until its timeout.
      await vi.advanceTimersByTimeAsync(30_000);
      push(`${PING}${textFrame("first text chunk")}`);
      await vi.advanceTimersByTimeAsync(30_000);
      push(`${PING}${textFrame("second text chunk")}`);
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await pending;

      expect(text(result)).toContain("Silence-reconciled answer");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("returns an unknown-state note while the running monitor continues retrying", async () => {
    write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
    configure(ws, FAKED_URL);
    const capture = await start();
    const tool = executable(capture);
    const firstRead = deferred<void>();
    const remote = fakeWorkflowFetch({
      stream: (push, close) => {
        push(RECONNECT);
        close();
      },
      read: () => {
        firstRead.resolve();
        return jsonResponse(503, { error: "Temporarily unavailable" });
      },
    });
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", remote.fetch);
    try {
      const pending = outcome(tool);
      await beforeEnd(firstRead.promise, pending, "the first state read");
      await vi.advanceTimersByTimeAsync(0);

      // File discovery and fetch/body parsing are async work outside the fake clock. Wait for the
      // first GET, drain its continuations, then step the retry timers; five failed reads plus the
      // capped backoff is what the total must clear.
      await pump(16, 20_000);
      const result = await pending;
      const readsAtReturn = remote.reads();
      const status = await run(executable(capture, "AgentStatus"), {});
      await vi.advanceTimersByTimeAsync(30_000);

      expect(result.isError).toBe(false);
      expect(result.text).toMatch(/stalled|unknown|degraded/i);
      expect(text(status)).toContain("audit");
      expect(text(status)).toMatch(/running/i);
      // Exhaustion hands the call back after repeated failed observations, never after one,
      // and the detached monitor keeps reconciling.
      expect(readsAtReturn).toBeGreaterThanOrEqual(2);
      expect(remote.reads()).toBeGreaterThan(readsAtReturn);
      await shutdownSession(capture);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("workflow call display", () => {
  it("renders the whole call as the supplied parameters, in schema order, with nothing added", async () => {
    write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
    const tool = workflowTool(await start());
    const prompt = "Investigate all relevant changes. ".repeat(5);
    const call = tool?.renderCall?.(
      { workflow: "audit", prompt, path: "/srv/project", run_in_background: false },
      defaultTheme,
    );

    expect(renderedRows(call)).toEqual([
      "Workflow audit",
      // pi-tui pads each row to the full width, so the prompt's own trailing space is padding here.
      `  prompt=${prompt.trimEnd()}`,
      "  path=/srv/project",
      "  run_in_background=false",
    ]);
  });

  it("renders server text without terminal control sequences", async () => {
    const escape = "\u001b[?25l";
    const frames = DISPATCH + textFrame(`Visible progress ${escape} safe suffix`) + TERMINAL;
    const remote = await server({
      streams: [frames],
      result: { text: `Visible answer ${escape} safe suffix`, usage: {}, termination_reason: "final_answer" },
    });
    install(remote);
    const tool = executable(await start());
    expect(tool.renderResult, "Workflow must render its result").toBeTypeOf("function");
    const args = { workflow: "audit", prompt: "Review changes" };
    const { views, paint } = liveViews(tool, args);

    const result = await run(tool, args, undefined, paint);
    paint(result);

    expect(views.some((view) => view.includes("Visible progress"))).toBe(true);
    expect(views.some((view) => view.includes("Visible answer"))).toBe(true);
    expect(views.join("\n")).not.toContain(escape);
  });

  it("renders a server error without terminal control sequences", async () => {
    // An OSC sequence, not the DEC private mode the result-path test uses: each carrier has to
    // reach the sanitizer on the error path too.
    const sequence = "\u001b]0;injected title\u0007";
    const remote = await server({
      rejection: { status: 422, body: errorBody(`Remote validation failed ${sequence} keep this part`) },
    });
    install(remote);
    const tool = executable(await start());
    expect(tool.renderResult, "Workflow must render its result").toBeTypeOf("function");
    const args = { workflow: "audit", prompt: "Review changes" };

    const result = await run(tool, args);
    const view = resultView(tool, result, args);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("keep this part");
    expect(view).toContain("keep this part");
    // C0 controls other than the layout's own whitespace, and the C1 forms, must not survive.
    for (const surface of [text(result), view]) {
      expect(surface).not.toContain(sequence);
      for (const line of surface.split("\n")) {
        expect(hasTerminalControl(line), `no terminal control character may reach the error view: ${line}`).toBe(false);
      }
    }
  });

  it("does not invent optional call arguments", async () => {
    write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
    const tool = workflowTool(await start());
    const call = tool?.renderCall?.({ workflow: "audit", prompt: "Review changes" }, defaultTheme);

    expect(renderedRows(call)).toEqual(["Workflow audit", "  prompt=Review changes"]);
  });
});
