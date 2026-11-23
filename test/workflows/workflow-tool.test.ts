/**
 * workflow-tool.test.ts — The `Workflow` tool surface: endpoint routing and refusal, the call line while
 * arguments are still streaming, and schema re-registration after a listing change.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vite-plus/test";
import { renderWorkflowCall } from "../../src/workflows/workflow-tool.js";
import {
  createMockExtensionAPI,
  fakeCtx,
  loadExtension,
  type MockExtensionAPI,
  type RegisteredTool,
} from "../fixtures.js";
import { defaultTheme, defaultUi } from "../mock-utils.js";
import { setWorkflowsEnabled } from "./session.js";

/** A graph-schema Workflow file, small enough to read in a test failure. */
function workflowFile(name: string, description: string, endpoint?: string): string {
  const target = endpoint ? `endpoint: ${endpoint}\n` : "";
  return `name: ${name}\ndescription: ${description}\n${target}nodes:\n  - id: analysis\nedges: []\nentry_node: analysis\n`;
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
/** Session notices shown during the session under test, so a skipped scan can be told from a silent file. */
let notices: Mock;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workflow-tool-"));
  agentDir = join(root, "agent");
  project = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  api = undefined;
  ctx = undefined;
  notices = vi.fn();
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

/** Load the extension and run its session start, which scans the Workflow folders when the setting is on. */
async function startSession(files: Record<string, string>, enabled = true): Promise<void> {
  setWorkflowsEnabled(agentDir, enabled);
  for (const [name, content] of Object.entries(files)) write(join(agentDir, "workflows", name), content);
  api = createMockExtensionAPI();
  ctx = fakeCtx({
    cwd: project,
    isProjectTrusted: () => true,
    ui: { ...defaultUi, notify: notices },
  });
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
 * Call the tool with a fake transport and report every request plus the returned tool error or thrown error.
 * The error may be a refusal before sending or a rejection from an endpoint after sending; a refused target
 * must ask for nothing, so both outcomes stay observable.
 */
async function callTool(params: Record<string, unknown>): Promise<{ sent: Sent[]; refusal: string }> {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push({ url: request.url, authorization: request.headers.get("authorization") });
    return new Response(JSON.stringify({ error: "Controlled endpoint rejection" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  });
  try {
    const result = await runTool(params);
    return { sent, refusal: result.isError ? text(result) : "" };
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

    const { sent } = await callTool({ workflow: "audit", prompt: "Review changes" });

    expect(sent).toEqual([{ url: "http://127.0.0.1:1/api/workflows", authorization: "Bearer global-key" }]);
  });

  // The name a project invented is not an endpoint the global file named, and `Object.prototype` carries
  // `constructor`, so neither the merge nor the resolver may treat it as one (ADR-0008, US-34).
  it("refuses a Workflow file whose endpoint name only Object.prototype carries, sending nothing", async () => {
    endpointAt("http://127.0.0.1:1");
    projectEndpoints({ constructor: { url: "http://127.0.0.1:2" } });
    await startSession({ "audit.yaml": workflowFile("audit", "Inspect a repository", "constructor") });

    const { sent, refusal } = await callTool({ workflow: "audit", prompt: "Review changes" });

    expect(refusal).toContain('"constructor" is not configured');
    expect(sent).toEqual([]);
  });

  it("refuses the unusable URL a trusted project's entry declares instead of inheriting the global one", async () => {
    endpointAt("http://127.0.0.1:1");
    projectEndpoints({ test: { url: "" } });
    await startSession({ "audit.yaml": workflowFile("audit", "Inspect a repository") });

    const { sent, refusal } = await callTool({ workflow: "audit", prompt: "Review changes" });

    expect(refusal).toContain('"test" (workflows.endpoints[test].url)');
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

describe("workflows off — a flip that needs a pi restart", () => {
  // Valid YAML with no name is what makes the scan speak, so the OFF arm can be told from a quiet file.
  const nameless = "nodes: []\n";

  it("scans no folder and registers no tool while the setting is off", async () => {
    await startSession({ "nameless.yaml": nameless }, false);

    expect(notices).not.toHaveBeenCalled();
    expect(workflowRegistrations()).toHaveLength(0);
  });

  it("scans and registers that same folder once the setting is on", async () => {
    await startSession({ "nameless.yaml": nameless });

    expect(notices).toHaveBeenCalledWith(expect.stringContaining('Skipping workflow file "nameless.yaml"'), "warning");
    expect(workflowRegistrations().length).toBeGreaterThan(0);
  });
});
