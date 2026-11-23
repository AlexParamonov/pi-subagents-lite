/**
 * menu-running-agents.ts — Running agents menu concern.
 *
 * SelectList from @earendil-works/pi-tui, via ctx.ui.custom: the agent list, then a per-agent action
 * submenu. The panes its actions open live in record-details.ts and text-pane.ts.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, type Component, type SelectItem } from "@earendil-works/pi-tui";
import type { AgentRecord } from "../../types.ts";
import { SHORT_ID_LENGTH } from "../../types.ts";
import { openRecordDetails } from "../record-details.ts";
import { showTextPane } from "../text-pane.ts";
import { getDisplayName, recordDisplayName, agentBulletPrefix, formatMs } from "../format.ts";
import { plainText } from "../sanitize.ts";
import { SEPARATOR_ID, buildSelectListTheme, createDelegatingComponent, installSeparatorSkip } from "./helpers.ts";
import { getManager } from "../../shell.ts";
import type { Theme } from "../types.ts";

/** Running or queued — the only non-terminal statuses (ADR-0006: active work is never cleared). */
function isActive(record: AgentRecord): boolean {
  return record.lifecycle.status === "running" || record.lifecycle.status === "queued";
}

/** The frozen text a record ends with, shown the way every pane here shows a text. */
function showTextViewer(
  ctx: ExtensionCommandContext,
  record: AgentRecord,
  kind: "result" | "error",
  text: string,
): Promise<void> {
  // Error text carries provider bodies and child stderr, result text carries whatever the
  // agent echoed back: neither may reach the terminal with a control sequence intact.
  const lines = text.split("\n").map((line) => plainText(line));
  const suffix = kind === "result" ? record.id.slice(0, SHORT_ID_LENGTH) : "Error";
  const name = recordDisplayName(record, getDisplayName(record.display.type));
  return showTextPane(ctx.ui, { title: `${name} \u00b7 ${suffix}`, rows: () => lines });
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
  setActive: (c: Component) => void,
  onClose: () => void,
): SelectList {
  const items: SelectItem[] = [];
  const shortId = record.id.slice(0, SHORT_ID_LENGTH);
  const isRunning = isActive(record);
  const hasSession = !!record.execution.session;
  const hasResult = !!record.result && record.result.length > 0;
  const hasError = !!record.error && record.error.length > 0;

  if (record.workflow) {
    // A run has no conversation to show, but it has what this client watched: its entries, one per row.
    items.push({ value: "view-details", label: "View details" });
  }
  if (record.lifecycle.status === "running" && hasSession) {
    items.push({ value: "view-snapshot", label: "View snapshot" });
  }
  if (hasSession && !isRunning) {
    items.push({ value: "view-conversation", label: "View conversation" });
  }
  if (hasResult) {
    items.push({ value: "view-result", label: "View result" });
  }
  if (hasError) {
    items.push({ value: "view-error", label: "View error" });
  }
  if (isRunning) {
    // US-29: a workflow run has no session to steer — it takes input when it is created and nothing
    // after. Stopping it is offered because the endpoint does answer a stop.
    if (!record.workflow) items.push({ value: "steer", label: "Steer" });
    items.push({ value: "stop", label: "Stop" });
  } else {
    items.push({ value: "clear", label: "Clear" });
  }

  if (items.length === 0) {
    ctx.ui.notify(`Agent ${shortId} — no actions available`, "info");
    done();
    return new SelectList([], 5, buildSelectListTheme(theme));
  }

  const list = new SelectList(items, 10, buildSelectListTheme(theme));
  list.onSelect = async (item) => {
    if (item.value === "view-snapshot" || item.value === "view-conversation" || item.value === "view-details") {
      await openRecordDetails(ctx.ui, record);
    } else if (item.value === "view-result") {
      await showTextViewer(ctx, record, "result", record.result!);
    } else if (item.value === "view-error") {
      await showTextViewer(ctx, record, "error", record.error!);
    } else if (item.value === "steer") {
      // Swap to an inline steer input within the menu context.
      const input = new Input();
      input.setValue("");
      input.onSubmit = async (value) => {
        const trimmed = value.trim();
        if (trimmed) {
          const sent = await getManager()!.steer(record.id, trimmed);
          ctx.ui.notify(sent ? `Steer sent to ${shortId}…` : `Steer failed for ${shortId}`, sent ? "info" : "error");
        }
        setActive(list);
      };
      input.onEscape = () => setActive(list);
      setActive(input);
    } else if (item.value === "stop") {
      getManager()?.abort(record.id, "user");
      // A remote run's stop is the endpoint's answer, which arrives after the menu closes.
      ctx.ui.notify(record.workflow ? `Stop requested for ${shortId}` : `Stopped ${shortId}`, "info");
      onClose();
    } else if (item.value === "clear") {
      getManager()?.clear(record.id);
      ctx.ui.notify(`Cleared ${shortId}`, "info");
      onClose();
    }
  };
  list.onCancel = () => done();
  return list;
}

export async function showRunningAgentsMenu(ctx: ExtensionCommandContext): Promise<void> {
  const agents = getManager()?.listAgents() ?? [];
  if (agents.length === 0) {
    ctx.ui.notify("No agents have been spawned this session", "info");
    return;
  }
  const running = agents.filter(isActive);
  const finished = agents.filter((r) => !isActive(r));
  const completed = agents.filter((r) => r.lifecycle.status === "completed");

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const buildAgentItems = (): SelectItem[] => {
      // One timestamp for every row: rows stay mutually consistent instead of
      // skewing by a millisecond per Date.now() call.
      const now = Date.now();
      const items: SelectItem[] = agents.map((record) => {
        // Finished runs freeze at completion; the now fallback is defensive only
        // (completedAt is stamped on every terminal path and cleared on continue).
        const active = isActive(record);
        const end = active ? now : (record.lifecycle.completedAt ?? now);
        const duration = formatMs(end - record.lifecycle.startedAt);
        const ago = active ? "" : ` ${formatMs(now - end)} ago`;
        const statusIcon =
          record.lifecycle.status === "running"
            ? "\u25B6"
            : record.lifecycle.status === "completed"
              ? "\u2713"
              : record.lifecycle.status === "queued"
                ? "\u23F3"
                : record.lifecycle.status === "error"
                  ? "\u2717"
                  : "\u2022";
        const headline = record.display.description ? record.display.description : "";
        const suffix = headline ? ` \u2014 ${headline}` : "";
        const bullet = agentBulletPrefix(record.display.type);
        return {
          value: record.id,
          label: `${statusIcon} ${record.id.slice(0, SHORT_ID_LENGTH)}  ${bullet}${recordDisplayName(record, record.display.type)}  ${record.lifecycle.status}  ${duration}${suffix}${ago}`,
        };
      });
      if (running.length > 0) {
        items.push({ value: SEPARATOR_ID, label: " " });
        items.push({ value: "__stop-all", label: `Stop ${running.length} running agent(s)` });
      }
      if (finished.length > 0) {
        // One group: "Clear done" (only when completed agents exist) above "Clear all".
        // completed is always a subset of finished, so the group is [Clear done, Clear all]
        // or [Clear all] — never [Clear done] alone.
        items.push({ value: SEPARATOR_ID, label: " " });
        if (completed.length > 0) {
          items.push({ value: "__clear-done", label: "Clear done" });
        }
        items.push({ value: "__clear-all", label: "Clear all" });
      }
      return items;
    };

    const agentList = new SelectList(buildAgentItems(), 15, buildSelectListTheme(theme));
    // SelectList does not skip __sep__ rows itself; install the same skip
    // mechanism the wrapped menus use.
    installSeparatorSkip(agentList);

    const delegator = createDelegatingComponent(agentList);

    agentList.onSelect = async (item) => {
      if (item.value === "__stop-all") {
        for (const r of running) {
          getManager()?.abort(r.id, "user");
        }
        // Honest for the mixed case: a workflow run's stop is only requested here.
        const wording = running.some((r) => r.workflow) ? "Stop requested for" : "Stopped";
        ctx.ui.notify(`${wording} ${running.length} running agent(s)`, "info");
        done(undefined);
        return;
      }
      if (item.value === "__clear-all") {
        for (const r of finished) {
          getManager()?.clear(r.id);
        }
        ctx.ui.notify(`Cleared ${finished.length} finished agent(s)`, "info");
        done(undefined);
        return;
      }
      if (item.value === "__clear-done") {
        for (const r of completed) {
          getManager()?.clear(r.id);
        }
        ctx.ui.notify(`Cleared ${completed.length} completed agent(s)`, "info");
        done(undefined);
        return;
      }
      const record = agents.find((r) => r.id === item.value);
      if (record) {
        const actionsList = buildAgentActionsList(
          ctx,
          record,
          theme,
          () => {
            delegator.setActive(agentList);
          },
          delegator.setActive.bind(delegator),
          () => done(undefined),
        );
        delegator.setActive(actionsList);
      }
    };
    agentList.onCancel = () => done(undefined);

    // Simple title wrapper — SettingsListWrapper doesn't work with delegators
    // because it intercepts onSelect on the wrapper target, not on the active child.
    const sep = "\u2500";
    const title = theme.bold(theme.fg("accent", "Running Agents"));
    return {
      invalidate() {
        delegator.invalidate();
      },
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
      handleInput(data: string) {
        delegator.handleInput?.(data);
      },
    };
  });
}
