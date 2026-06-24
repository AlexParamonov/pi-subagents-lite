/**
 * menu-running-agents.ts — Running agents menu concern.
 *
 * Uses SelectList from @earendil-works/pi-tui via ctx.ui.custom.
 * Agent list is a snapshot at construction time (stale until re-entry is acceptable).
 * Selecting an agent opens an actions submenu (SelectList).
 *
 * Exports:
 *   - showRunningAgentsMenu: list running/queued/completed agents
 *   - buildAgentActionsList: per-agent action sub-menu (view result, steer, stop)
 *
 * Private helper (single-consumer, co-located):
 *   - showResultViewer: show ResultViewer for agent result/error/snapshot
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, type SelectItem } from "@earendil-works/pi-tui";
import type { AgentRecord } from "../../types.js";
import { SHORT_ID_LENGTH } from "../../types.js";
import { ResultViewer, type ResultViewerStats } from "../result-viewer.js";
import { getDisplayName, truncateDesc } from "../format.js";
import { buildSnapshotMarkdown } from "../../prompt/context.js";
import { buildSelectListTheme, createDelegatingComponent } from "./helpers.js";
import { getManager, getStore } from "../../shell.js";
import type { Theme } from "../types.js";

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
    { overlay: true },
  );
}

/**
 * Build a SelectList of actions for a single agent (view result/error/snapshot,
 * steer, stop) for use as a submenu inside a delegating component.
 * @param done — return to the parent agent list (cancel / no actions).
 * @param setActive — swap the delegating component's active child (steer input).
 * @param onClose — close the entire menu (stop).
 */
export function buildAgentActionsList(
  ctx: ExtensionCommandContext,
  record: AgentRecord,
  theme: Theme,
  done: () => void,
  setActive: (c: import("@earendil-works/pi-tui").Component) => void,
  onClose: () => void,
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
      // Swap to an inline steer input within the menu context.
      const input = new Input();
      input.setValue("");
      input.onSubmit = async (value) => {
        const trimmed = value.trim();
        if (trimmed) {
          const sent = await getManager()!.steer(record.id, trimmed);
          ctx.ui.notify(
            sent ? `Steer sent to ${shortId}…` : `Steer failed for ${shortId}`,
            sent ? "info" : "error",
          );
        }
        setActive(list);
      };
      input.onEscape = () => setActive(list);
      setActive(input);
    } else if (item.value === "stop") {
      getManager()?.abort(record.id);
      ctx.ui.notify(`Stopped ${shortId}`, "info");
      onClose();
    }
  };
  list.onCancel = () => done();
  return list;
}

export async function showRunningAgentsMenu(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const agents = getManager()?.listAgents() ?? [];
  if (agents.length === 0) {
    ctx.ui.notify("No agents have been spawned this session", "info");
    return;
  }
  const running = agents.filter(
    (r) => r.lifecycle.status === "running" || r.lifecycle.status === "queued",
  );

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const buildAgentItems = (): SelectItem[] => {
      const items: SelectItem[] = agents.map((record) => {
        const elapsed = Math.round((Date.now() - record.lifecycle.startedAt) / 1000);
        const statusIcon = record.lifecycle.status === "running" ? "\u25B6" :
          record.lifecycle.status === "completed" ? "\u2713" :
          record.lifecycle.status === "queued" ? "\u23F3" :
          record.lifecycle.status === "error" ? "\u2717" : "\u2022";
        const descLen = getStore().agent.widgetDescLengthFull;
        const headline = record.display.description
          ? truncateDesc(record.display.description, descLen)
          : "";
        const suffix = headline ? ` \u2014 ${headline}` : "";
        return {
          value: record.id,
          label: `${statusIcon} ${record.id.slice(0, SHORT_ID_LENGTH)}  ${record.display.type}  ${record.lifecycle.status}  ${elapsed}s${suffix}`,
        };
      });
      if (running.length > 0) {
        items.push({ value: "__sep__", label: " " });
        items.push({ value: "__stop-all", label: `Stop ${running.length} running agent(s)` });
      }
      return items;
    };

    const agentList = new SelectList(buildAgentItems(), 15, buildSelectListTheme(theme));
    const delegator = createDelegatingComponent(agentList);

    agentList.onSelect = async (item) => {
      if (item.value === "__stop-all") {
        for (const r of running) {
          getManager()?.abort(r.id);
        }
        ctx.ui.notify(`Stopped ${running.length} agent(s)`, "info");
        done(undefined);
        return;
      }
      const record = agents.find((r) => r.id === item.value);
      if (record) {
        const actionsList = buildAgentActionsList(ctx, record, theme, () => {
          delegator.setActive(agentList);
        }, delegator.setActive.bind(delegator), () => done(undefined));
        delegator.setActive(actionsList);
      }
    };
    agentList.onCancel = () => done(undefined);

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
  });
}
