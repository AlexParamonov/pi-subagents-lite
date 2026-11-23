/**
 * workflow-tool.ts — The `Workflow` tool: schema, execution entry, call rendering.
 *
 * The schema lists the current Workflow listing in the `workflow` parameter, so the main agent
 * selects a workflow without a briefing message (US-5). Re-register after a rescan that changed the
 * listing; registration rebuilds the system prompt, so an unchanged listing re-registers nothing.
 */

import { Type } from "typebox";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getCoordinator, getManager, getPiInstance, getStore } from "../shell.ts";
import type { AgentRecord } from "../types.ts";
import { notedRow, recordRow } from "../ui/format.ts";
import { plainText } from "../ui/sanitize.ts";
import type { Theme } from "../ui/types.ts";
import { registerAgentInvalidation } from "../ui/renderer.ts";
import { resolveWorkflowEndpoint } from "./endpoints.ts";
import { createWorkflowClient } from "./workflow-client.ts";
import { runWorkflow } from "./workflow-run.ts";
import { formatWorkflowListing, getWorkflowListing, resolveWorkflow } from "./workflow-registry.ts";
import { workflowWarningSink } from "./workflow-notices.ts";

/** The call line shows the parameters other than `workflow`, in schema order, as supplied. */
const SUPPLIED_PARAMETERS = ["prompt", "path", "run_in_background"] as const;

export function registerWorkflowTool(pi: ExtensionAPI): void {
  const listing = getWorkflowListing();
  const workflow = listing.length > 0 ? Type.String({ description: formatWorkflowListing(listing) }) : Type.String();

  pi.registerTool({
    name: "Workflow",
    label: "Workflow",
    description:
      "Run a Workflow file from the local workflow library on its configured Workflow endpoint, and wait " +
      "for the result the server holds when the run settles.",
    parameters: Type.Object(
      {
        workflow,
        prompt: Type.String({ description: "The task to hand the workflow." }),
        path: Type.Optional(
          Type.String({ description: "Working directory for the run. Defaults to the session's current directory." }),
        ),
        run_in_background: Type.Optional(
          Type.Boolean({
            description:
              "Return the run's id immediately instead of waiting for the answer. " +
              "The result arrives as a notification when the run settles.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: executeWorkflowTool,
    renderCall: renderWorkflowCall,
    renderResult: renderWorkflowResult,
  });
}

export async function executeWorkflowTool(
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const name = typeof params.workflow === "string" ? params.workflow.trim() : "";
  const resolution = await resolveWorkflow(name, workflowWarningSink(ctx));
  if (resolution.listingChanged) registerWorkflowTool(getPiInstance());
  if (resolution.kind === "not-found") throw new Error(unknownWorkflowMessage(name, resolution.available));

  const workflows = getStore().workflows;
  const endpoint = resolveWorkflowEndpoint(workflows, resolution.definition.endpoint);
  if (!endpoint.ok) throw new Error(endpoint.error);

  const manager = getManager();
  if (!manager) throw new Error("Agent manager is unavailable");
  const coordinator = getCoordinator();
  if (!coordinator) throw new Error("Spawn coordinator is unavailable");

  return runWorkflow(
    {
      name,
      endpoint: endpoint.endpoint,
      definition: resolution.definition,
      prompt: typeof params.prompt === "string" ? params.prompt : "",
      workingDir: workingDirOf(params.path, ctx.cwd),
      toolCallId,
      runInBackground: params.run_in_background === true,
      signal,
      onUpdate,
      ctx,
    },
    {
      manager,
      client: createWorkflowClient(endpoint.endpoint, { endpointNames: Object.keys(workflows.endpoints) }),
      nudges: coordinator,
    },
  );
}

/** `path` is the run's working directory; anything but a usable string is the session's own. */
function workingDirOf(path: unknown, cwd: string): string {
  return typeof path === "string" && path.trim() !== "" ? path : cwd;
}

/**
 * The call's result view: what this run's connection delivered, then the outcome. The record decides
 * that outcome for as long as it lives, so a repaint after the call returned shows the run's live
 * health, and a call that returned early still shows what the run turned out to be.
 */
export function renderWorkflowResult(
  result: { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> },
  _options: { expanded?: boolean },
  theme: Theme,
  context: { isError?: boolean; invalidate?: () => void },
): Text {
  const details = result.details ?? {};
  const agentId = typeof details.agentId === "string" ? details.agentId : undefined;
  if (agentId && context?.invalidate) registerAgentInvalidation(agentId, context.invalidate);
  const record = agentId ? getManager()?.getRecord(agentId) : undefined;
  const content = result.content.find((part) => part.type === "text")?.text ?? "";
  // The monitor keeps the record's snapshot current after this call returned; `details.progress`
  // is only what the wait had seen when it ended.
  const progress =
    record?.workflow?.progress ?? (Array.isArray(details.progress) ? (details.progress as string[]) : []);
  const rows = [...progress, ...outcomeRows(record, content)].map((row) => plainText(row)).filter((row) => row !== "");
  const mark = context?.isError ? theme.fg("error", "\u2717") : "";
  const body = rows.map((row) => `  ${theme.fg("toolOutput", row)}`).join("\n");
  return new Text(mark === "" ? body : `${mark} ${body.trimStart()}`, 0, 0);
}

/** A settled run shows the one text it ended with. A live one shows its own id, state and note, and
 * never the text its call returned: for a foreground call that text is a note a later read retracted.
 * A run launched in the background keeps its launch receipt beside that, as a launch fact, not health. */
function outcomeRows(record: AgentRecord | undefined, content: string): string[] {
  if (!record) return [content];
  if (record.lifecycle.status !== "running") return [record.error ?? record.result ?? ""];
  const note = record.workflow?.note;
  if (!note) {
    return record.display.invocation?.runInBackground ? [recordRow(record), content] : [recordRow(record)];
  }
  return [notedRow(record, { oneLine: true })];
}

/** The call line: the workflow name, then exactly the optional parameters the agent supplied. */
export function renderWorkflowCall(args: Record<string, unknown>, theme: Theme): Text {
  const name = argText(args.workflow);
  const rows = [theme.fg("toolTitle", theme.bold(`Workflow${name ? ` ${name}` : ""}`))];
  for (const key of SUPPLIED_PARAMETERS) {
    const value = args[key];
    if (value == null) continue;
    rows.push(`  ${theme.fg("muted", `${key}=${argText(value)}`)}`);
  }
  return new Text(rows.join("\n"), 0, 0);
}

function unknownWorkflowMessage(name: string, available: string[]): string {
  if (available.length === 0) {
    return (
      `Unknown workflow "${name}". No workflows are available: add a YAML workflow file to ` +
      "~/.pi/agent/workflows, <project>/.agents/workflows or <project>/.pi/workflows."
    );
  }
  return `Unknown workflow "${name}". Available workflows: ${available.join(", ")}.`;
}

/** Pi renders the call while the arguments stream, so an argument that is not there yet shows nothing. */
function argText(value: unknown): string {
  if (typeof value === "string") return plainText(value);
  return typeof value === "boolean" ? String(value) : "";
}
