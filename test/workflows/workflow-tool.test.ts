/**
 * workflow-tool.test.ts — The `Workflow` tool's own surface: the call line while arguments are
 * still streaming, and the schema re-registration a listing change requires.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderWorkflowCall } from "../../src/workflows/workflow-tool.js";
import {
  createMockExtensionAPI,
  fakeCtx,
  loadExtension,
  type MockExtensionAPI,
  type RegisteredTool,
} from "../fixtures.js";
import { defaultTheme } from "../mock-utils.js";

/** A graph-schema Workflow file, small enough to read in a test failure. */
function workflowFile(name: string, description: string): string {
  return `name: ${name}\ndescription: ${description}\nnodes:\n  - id: analysis\nedges: []\nentry_node: analysis\n`;
}

interface ExecutableTool extends RegisteredTool {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
    context: ExtensionContext,
  ): Promise<AgentToolResult<Record<string, unknown>>>;
}

let root: string;
let agentDir: string;
let project: string;
let api: MockExtensionAPI | undefined;
let ctx: ExtensionContext | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workflow-tool-"));
  agentDir = join(root, "agent");
  project = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  api = undefined;
  ctx = undefined;
  vi.resetModules();
  vi.doMock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
    getAgentDir: () => agentDir,
  }));
});

afterEach(async () => {
  const shutdown = api?.listeners.find((listener) => listener.event === "session_shutdown");
  if (shutdown && ctx) await shutdown.handler({ type: "session_shutdown", reason: "quit" }, ctx);
  vi.doUnmock("@earendil-works/pi-coding-agent");
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Load the extension and run its session start, which scans the Workflow folders. */
async function startSession(files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) write(join(agentDir, "workflows", name), content);
  api = createMockExtensionAPI();
  ctx = fakeCtx({ cwd: project, isProjectTrusted: () => true });
  await loadExtension(api.api);
  const listener = api.listeners.find((entry) => entry.event === "session_start");
  expect(listener, "the extension must handle session start").toBeDefined();
  await listener!.handler({ type: "session_start", reason: "startup" }, ctx);
}

function workflowRegistrations(): ExecutableTool[] {
  return (api?.tools.filter((tool) => tool.name === "Workflow") ?? []) as ExecutableTool[];
}

function newestWorkflowParameterDescription(): string {
  const property = workflowRegistrations().at(-1)?.parameters.properties.workflow as { description?: string };
  return property?.description ?? "";
}

/** Call the tool through the registration the main agent sees. */
function runTool(params: Record<string, unknown>): Promise<AgentToolResult<Record<string, unknown>>> {
  const tool = workflowRegistrations().at(-1);
  expect(tool, "the Workflow tool must be registered").toBeDefined();
  return tool!.execute("workflow-call", params, undefined, undefined, ctx!);
}

function text(result: AgentToolResult<Record<string, unknown>>): string {
  return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

/** An endpoint the test owns, so a reached run path fails here instead of on a real network. */
function endpointAt(url: string): void {
  write(
    join(agentDir, "subagents-lite.json"),
    JSON.stringify({ workflows: { endpoints: { test: { url, apiKey: "global-key" } }, defaultEndpoint: "test" } }),
  );
}

/** A project override the trusted project's own config file carries. */
function projectEndpoints(endpoints: unknown): void {
  write(join(project, ".pi", "subagents-lite.json"), JSON.stringify({ workflows: { endpoints } }));
}

interface Sent {
  url: string;
  authorization: string | null;
}

/**
 * Call the tool with a fake transport: every request it asked for, and the message it refused with
 * (empty when it never refused). A refused target must ask for nothing, so both are always observable.
 */
async function callTool(params: Record<string, unknown>): Promise<{ sent: Sent[]; refusal: string }> {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push({ url: request.url, authorization: request.headers.get("authorization") });
    return new Response("{}", { status: 200 });
  });
  try {
    await runTool(params);
    return { sent, refusal: "" };
  } catch (err) {
    return { sent, refusal: (err as Error).message };
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("Workflow endpoint", () => {
  it("refuses the configured endpoint whose URL is unusable, sending nothing", async () => {
    // US-34: a broken target is not the same as no target. The built-in name is the one a dropped
    // entry could quietly restore, so this is the configuration that must never reach the endpoint.
    write(
      join(agentDir, "subagents-lite.json"),
      JSON.stringify({ workflows: { endpoints: { "anagen-x.local": { url: "" } } } }),
    );
    await startSession({ "audit.yaml": workflowFile("audit", "Inspect a repository") });

    const { sent, refusal } = await callTool({ workflow: "audit", prompt: "Review changes" });

    expect(refusal).toContain("anagen-x.local");
    expect(sent).toEqual([]);
  });

  it("refuses a default the file set to null instead of sending the run to another target", async () => {
    // US-34: null is a configured default that cannot be used, not an absent one - neither the built-in
    // target nor the perfectly usable endpoint named beside it may answer for it.
    write(
      join(agentDir, "subagents-lite.json"),
      JSON.stringify({
        workflows: { endpoints: { release: { url: "http://127.0.0.1:1" } }, defaultEndpoint: null },
      }),
    );
    await startSession({ "audit.yaml": workflowFile("audit", "Inspect a repository") });

    const { sent, refusal } = await callTool({ workflow: "audit", prompt: "Review changes" });

    expect(refusal).toContain("null");
    expect(refusal).toContain("release");
    expect(sent).toEqual([]);
  });

  // Declared versus not declared (ADR-0008): what the project entry does not declare it inherits -
  // including its unsupported apiKey, which is ignored and erases nothing - while a URL it does
  // declare is the target the run is refused against even when unusable.
  it("sends to the global URL and key a trusted project's entry leaves undeclared", async () => {
    endpointAt("http://127.0.0.1:1");
    projectEndpoints({ test: { apiKey: "project-key" } });
    await startSession({ "audit.yaml": workflowFile("audit", "Inspect a repository") });

    const { sent, refusal } = await callTool({ workflow: "audit", prompt: "Review changes" });

    expect(refusal).toBe("");
    expect(sent).toEqual([{ url: "http://127.0.0.1:1/api/workflows", authorization: "Bearer global-key" }]);
  });

  it("refuses the unusable URL a trusted project's entry declares instead of inheriting the global one", async () => {
    endpointAt("http://127.0.0.1:1");
    projectEndpoints({ test: { url: "" } });
    await startSession({ "audit.yaml": workflowFile("audit", "Inspect a repository") });

    const { sent, refusal } = await callTool({ workflow: "audit", prompt: "Review changes" });

    expect(refusal).toContain('"test" has an unusable URL ""');
    expect(sent).toEqual([]);
  });
});

describe("Workflow call line", () => {
  it("shows no placeholder for the workflow name while arguments stream", () => {
    const rows = renderWorkflowCall({ prompt: "Review changes" }, defaultTheme)
      .render(240)
      .map((row) => row.trimEnd());

    expect(rows).toEqual(["Workflow", "  prompt=Review changes"]);
  });
});

describe("Workflow schema refresh", () => {
  it("lists a workflow added after the session started once a call rescans", async () => {
    endpointAt("http://127.0.0.1:1/api/workflows");
    await startSession({ "audit.yaml": workflowFile("audit", "Inspect a repository") });
    write(join(agentDir, "workflows", "release.yml"), workflowFile("release-review", "Review a release"));

    // The call gets past the listing now, so what proves the rescan is the run it reached: the
    // configured endpoint answered nothing, and the refused URL is the test's own.
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("connect ECONNREFUSED")));
    let result: AgentToolResult<Record<string, unknown>>;
    try {
      result = await runTool({ workflow: "release-review", prompt: "Review the release" });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("http://127.0.0.1:1/api/workflows");
    expect(newestWorkflowParameterDescription()).toContain("release-review: Review a release");
  });

  it("re-registers nothing when a rescan found no new workflow", async () => {
    await startSession({ "audit.yaml": workflowFile("audit", "Inspect a repository") });
    const registrations = workflowRegistrations().length;

    await expect(runTool({ workflow: "audti", prompt: "Review changes" })).rejects.toThrow(/Unknown workflow/i);

    expect(workflowRegistrations()).toHaveLength(registrations);
  });
});
