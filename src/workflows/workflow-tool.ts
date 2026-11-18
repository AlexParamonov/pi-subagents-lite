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
import { getPiInstance } from "../shell.ts";
import { plainText } from "../ui/sanitize.ts";
import type { Theme } from "../ui/types.ts";
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
          Type.Boolean({ description: "Background runs are not supported yet; leave unset or pass false." }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: executeWorkflowTool,
    renderCall: renderWorkflowCall,
  });
}

export async function executeWorkflowTool(
  _toolCallId: string,
  params: Record<string, unknown>,
  _signal: AbortSignal | undefined,
  _onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const name = typeof params.workflow === "string" ? params.workflow.trim() : "";
  const resolution = await resolveWorkflow(name, workflowWarningSink(ctx));
  if (resolution.listingChanged) registerWorkflowTool(getPiInstance());
  if (resolution.kind === "not-found") throw new Error(unknownWorkflowMessage(name, resolution.available));

  throw new Error("Workflow run execution is not implemented");
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
