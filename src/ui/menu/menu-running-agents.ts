/**
 * menu-running-agents.ts — Running agents menu concern.
 *
 * Uses SelectList from @earendil-works/pi-tui via ctx.ui.custom.
 * Agent list is a snapshot at construction time (stale until re-entry is acceptable).
 * Selecting an agent opens an actions submenu (SelectList).
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
import { SelectList, type SelectItem } from "@earendil-works/pi-tui";
import type { AgentRecord } from "../../types.js";
import { SHORT_ID_LENGTH } from "../../types.js";
import { ResultViewer, type ResultViewerStats } from "../result-viewer.js";
import { getDisplayName, truncateDesc } from "../format.js";
import { buildSnapshotMarkdown } from "../../prompt/context.js";
import { buildSelectListTheme, createDelegatingComponent } from "./helpers.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { getManager, getStore } from "../../shell.js";

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
    modelName: record.display.invocation?.modelName,
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
 * Sub-menu with actions for a single agent.
 * Returns a SelectList Component for use as a submenu.
 */
export function buildAgentActionsList(
  ctx: ExtensionCommandContext,
  record: AgentRecord,
  theme: any,
  done: () => void,
): SelectList {
  const items: SelectItem[] = [];
  const shortId = record.id.slice(0, SHORT_ID_LENGTH);
  const isRunning = record.lifecycle.status === "running" || record.lifecycle.status === "queued";
  const hasSession = !!record.execution.session;
  const hasResult = !!record.result && record.result.length > 0;
  const hasError = !!record.error && record.error.length > 0;

  if (record.lifecycle.status === "running" && hasSession) {
    items.push({ value: "view-snapshot", label: "View snapshot" });
  }
  if (hasResult) {
    items.push({ value: "view-result", label: "View result" });
  }
  if (hasError) {
    items.push({ value: "view-error", label: "View error" });
  }
  if (isRunning) {
    items.push({ value: "steer", label: "Steer" });
    items.push({ value: "stop", label: "Stop" });
  }

  if (items.length === 0) {
    ctx.ui.notify(`Agent ${shortId} — no actions available`, "info");
    done();
    return new SelectList([], 5, buildSelectListTheme(theme));
  }

  const list = new SelectList(items, 10, buildSelectListTheme(theme));
  list.onSelect = async (item) => {
    if (item.value === "view-snapshot") {
      const messages = record.execution.session!.messages;
      const markdown = buildSnapshotMarkdown(messages);
      await showResultViewer(ctx, record, "snapshot", markdown);
    } else if (item.value === "view-result") {
      await showResultViewer(ctx, record, "result", record.result!);
    } else if (item.value === "view-error") {
      await showResultViewer(ctx, record, "error", record.error!);
    } else if (item.value === "steer") {
      await steerAgentById(record.id, ctx);
    } else if (item.value === "stop") {
      getManager()?.abort(record.id);
      ctx.ui.notify(`Stopped ${shortId}`, "info");
    }
  };
  list.onCancel = () => done();
  return list;
}

/**
 * Sub-menu with actions for a single agent. Standalone version for direct use.
 * Opens a ctx.ui.custom with the actions SelectList.
 */
export async function showAgentActions(
  ctx: ExtensionCommandContext,
  record: AgentRecord,
): Promise<void> {
  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const list = buildAgentActionsList(ctx, record, theme, () => done(undefined));
    return new SettingsListWrapper(list, { title: `Agent ${record.id.slice(0, SHORT_ID_LENGTH)}`, theme, onCancel: () => done(undefined) });
  });
}

/**
 * Create a running agents menu Component for use within a parent ctx.ui.custom.
 */
export function createRunningAgentsMenuComponent(
  ctx: ExtensionCommandContext,
  theme: any,
  onDone: () => void,
): import("@earendil-works/pi-tui").Component | null {
  const agents = getManager()?.listAgents() ?? [];
  if (agents.length === 0) {
    ctx.ui.notify("No agents have been spawned this session", "info");
    onDone();
    return null;
  }

  const buildAgentItems = (): SelectItem[] => agents.map((record) => {
    const elapsed = Math.round((Date.now() - record.lifecycle.startedAt) / 1000);
    const statusIcon = record.lifecycle.status === "running" ? "▶" :
      record.lifecycle.status === "completed" ? "✓" :
      record.lifecycle.status === "queued" ? "⏳" :
      record.lifecycle.status === "error" ? "✗" : "•";
    const descLen = getStore().agent.widgetDescLengthFull;
    const headline = record.display.description
      ? truncateDesc(record.display.description, descLen)
      : "";
    const suffix = headline ? ` — ${headline}` : "";
    return {
      value: record.id,
      label: `${statusIcon} ${record.id.slice(0, SHORT_ID_LENGTH)}  ${record.display.type}  ${record.lifecycle.status}  ${elapsed}s${suffix}`,
    };
  });

  const agentList = new SelectList(buildAgentItems(), 15, buildSelectListTheme(theme));
  const delegator = createDelegatingComponent(agentList);

  agentList.onSelect = async (item) => {
    const record = agents.find((r) => r.id === item.value);
    if (record) {
      const actionsList = buildAgentActionsList(ctx, record, theme, () => {
        delegator.setActive(agentList);
      });
      delegator.setActive(actionsList);
    }
  };
  agentList.onCancel = () => onDone();

  // Simple title wrapper — SettingsListWrapper doesn't work with delegators
  // because it intercepts onSelect on the wrapper target, not on the active child.
  const sep = "\u2500";
  const title = theme.bold(theme.fg("accent", "Running Agents"));
  return {
    invalidate() { delegator.invalidate(); },
    render(width: number) {
      const lines: string[] = [];
      lines.push(sep.repeat(width));
      lines.push("");
      lines.push("  " + title);
      lines.push("");
      lines.push(...delegator.render(width));
      lines.push("");
      lines.push(sep.repeat(width));
      return lines;
    },
    handleInput(data: string) { delegator.handleInput?.(data); },
  };
}

export async function showRunningAgentsMenu(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const records = getManager()?.listAgents() ?? [];
  if (records.length === 0) {
    ctx.ui.notify("No agents have been spawned this session", "info");
    return;
  }

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    return createRunningAgentsMenuComponent(ctx, theme, () => done(undefined))!;
  });
}
