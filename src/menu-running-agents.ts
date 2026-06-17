/**
 * menu-running-agents.ts — Running agents menu concern.
 *
 * Exports:
 *   - showRunningAgentsMenu: list running/queued/completed agents
 *   - showAgentActions: per-agent action sub-menu (view result, steer, stop)
 *
 * Private helpers (single-consumer, co-located):
 *   - showResultViewer: show ResultViewer for agent result/error/snapshot
 *   - steerAgentById: send steer message to a specific agent
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "./types.js";
import { SHORT_ID_LENGTH } from "./types.js";
import { ResultViewer, type ResultViewerStats } from "./result-viewer.js";
import { getDisplayName } from "./format.js";
import { buildSnapshotMarkdown } from "./context.js";
import { runMenuLoop, runMenu } from "./menu-helpers.js";
import { getManager } from "./shell.js";

/**
 * Show a ResultViewer for an agent's result, error, or snapshot.
 * @param kind — "result", "error", or "snapshot" — used for the title suffix
 */
async function showResultViewer(
  ctx: ExtensionCommandContext,
  record: AgentRecord,
  kind: "result" | "error" | "snapshot",
  text: string,
): Promise<void> {
  const titleSuffix = kind === "result"
    ? record.id.slice(0, SHORT_ID_LENGTH)
    : kind === "snapshot"
    ? `snapshot · ${record.id.slice(0, SHORT_ID_LENGTH)}`
    : "Error";
  const stats: ResultViewerStats = {
    lifetimeUsage: record.stats.lifetimeUsage,
    turnCount: record.stats.turnCount,
    durationMs: (record.lifecycle.completedAt ?? Date.now()) - record.lifecycle.startedAt,
  };
  const refreshCallback =
    kind === "snapshot" && record.execution.session
      ? () => buildSnapshotMarkdown(record.execution.session!.messages)
      : undefined;

  await ctx.ui.custom<void>(
    (tui, theme, _kb, done) =>
      new ResultViewer(
        `${getDisplayName(record.display.type)} · ${titleSuffix}`,
        text,
        { onClose: () => done(), onRefresh: refreshCallback },
        theme,
        tui.terminal.rows,
        stats,
      ),
  );
}

/**
 * Send a steer message to a specific agent. Used by the per-agent action menu.
 */
async function steerAgentById(
  agentId: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const record = getManager()?.getRecord(agentId);
  if (!record) {
    ctx.ui.notify("Agent not found", "error");
    return;
  }

  const message = await ctx.ui.input(`Steer ${record.display.type}`);
  if (!message?.trim()) return;

  const sent = await getManager()!.steer(agentId, message.trim());
  if (sent) {
    ctx.ui.notify(`Steer sent to ${record.id.slice(0, SHORT_ID_LENGTH)}…`, "info");
  } else {
    ctx.ui.notify(`Steer failed for ${record.id.slice(0, SHORT_ID_LENGTH)}`, "error");
  }
}

/**
 * Sub-menu with actions for a single agent. Replaces the old showAgentDetail
 * notify popup — clicking an agent in the running agents menu opens actions.
 */
export async function showAgentActions(
  ctx: ExtensionCommandContext,
  record: AgentRecord,
): Promise<void> {
  const items: string[] = [];
  const actions: Array<() => Promise<void>> = [];

  const isRunning = record.lifecycle.status === "running" || record.lifecycle.status === "queued";
  const hasSession = !!record.execution.session;
  const hasResult = !!record.result && record.result.length > 0;
  const hasError = !!record.error && record.error.length > 0;

  // View actions first
  if (record.lifecycle.status === "running" && hasSession) {
    items.push("View snapshot");
    actions.push(async () => {
      const messages = record.execution.session!.messages;
      const markdown = buildSnapshotMarkdown(messages);
      await showResultViewer(ctx, record, "snapshot", markdown);
    });
  }

  if (hasResult) {
    items.push("View result");
    actions.push(async () => {
      await showResultViewer(ctx, record, "result", record.result!);
    });
  }

  if (hasError) {
    items.push("View error");
    actions.push(async () => {
      await showResultViewer(ctx, record, "error", record.error!);
    });
  }

  // Then control actions
  if (isRunning) {
    items.push("Steer");
    actions.push(async () => {
      await steerAgentById(record.id, ctx);
    });

    items.push("Stop");
    actions.push(async () => {
      getManager()?.abort(record.id);
      ctx.ui.notify(`Stopped ${record.id.slice(0, SHORT_ID_LENGTH)}`, "info");
    });
  }

  if (items.length === 0) {
    ctx.ui.notify(`Agent ${record.id.slice(0, SHORT_ID_LENGTH)} — no actions available`, "info");
    return;
  }

  // Append blank spacer + "Back" as the last items
  items.push("");
  actions.push(async () => {});
  items.push("Back");
  actions.push(async () => {});

  await runMenu(ctx, `Agent ${record.id.slice(0, SHORT_ID_LENGTH)}`, items, actions);
}

export async function showRunningAgentsMenu(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const records = getManager()?.listAgents() ?? [];
  if (records.length === 0) {
    ctx.ui.notify("No agents have been spawned this session", "info");
    return;
  }

  return runMenuLoop(ctx, "Running Agents", () => {
    const records = getManager()?.listAgents() ?? [];
    const running = records.filter((r) => r.lifecycle.status === "running" || r.lifecycle.status === "queued");

    const items: string[] = [];
    const actions: Array<() => Promise<void>> = [];

    for (const record of records) {
      const elapsed = Math.round((Date.now() - record.lifecycle.startedAt) / 1000);
      const statusIcon = record.lifecycle.status === "running" ? "▶" :
        record.lifecycle.status === "completed" ? "✓" :
        record.lifecycle.status === "queued" ? "⏳" :
        record.lifecycle.status === "error" ? "✗" : "•";
      const headline = record.display.description
        ? (record.display.description.length > 50 ? record.display.description.slice(0, 47) + "..." : record.display.description)
        : "";
      const suffix = headline ? ` — ${headline}` : "";
      items.push(
        `${statusIcon} ${record.id.slice(0, SHORT_ID_LENGTH)}  ${record.display.type}  ${record.lifecycle.status}  ${elapsed}s${suffix}`,
      );

      actions.push(async () => {
        await showAgentActions(ctx, record);
      });
    }

    if (running.length > 0) {
      items.push("");
      actions.push(async () => {});
      items.push("─── actions ───");
      actions.push(async () => {}); // separator

      items.push(`Stop ${running.length} running agent(s)`);
      actions.push(async () => {
        for (const record of running) {
          getManager()?.abort(record.id);
        }
        ctx.ui.notify(`Stopped ${running.length} agent(s)`, "info");
      });
    }

    return { items, actions };
  });
}
