/**
 * menu-running-agents.ts — Running agents menu concern.
 *
 * Uses SelectList from @earendil-works/pi-tui via ctx.ui.custom.
 * Agent list is a snapshot at construction time (stale until re-entry is acceptable).
 * Selecting an agent opens an actions submenu (SelectList).
 *
 * Exports:
 *   - showRunningAgentsMenu: list running/queued/completed agents
 *   - buildAgentActionsList: per-agent action sub-menu (view result, steer, stop, clear)
 *
 * Private helpers (single-consumer, co-located):
 *   - showConversationViewer: show ConversationViewer for agent snapshot
 *   - showTextViewer: show simple text viewer for result/error
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  SelectList,
  truncateToWidth,
  visibleWidth,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";
import type { AgentRecord } from "../../types.js";
import { SHORT_ID_LENGTH } from "../../types.js";
import { ConversationViewer } from "../conversation-viewer.js";
import { getDisplayName } from "../format.js";
import { SEPARATOR_ID, buildSelectListTheme, createDelegatingComponent, installSeparatorSkip } from "./helpers.js";
import { getManager, getStore } from "../../shell.js";
import type { Theme } from "../types.js";

/** Running or queued — the only non-terminal statuses (ADR-0006: active work is never cleared). */
function isActive(record: AgentRecord): boolean {
  return record.lifecycle.status === "running" || record.lifecycle.status === "queued";
}

async function showConversationViewer(ctx: ExtensionCommandContext, record: AgentRecord): Promise<void> {
  if (!record.execution?.session) return;
  const manager = getManager();

  await ctx.ui.custom<void>(
    (tui, theme, kb, done) => {
      const viewer = new ConversationViewer(
        tui,
        record.execution.session!,
        record,
        theme,
        done,
        () => manager?.abort(record.id, "user"),
        kb,
        (msg: string) => manager?.steer(record.id, msg),
      );
      viewer.setModelDisplayStyle(getStore().agent.modelDisplayStyle);
      return viewer;
    },
    { overlay: true },
  );
}

async function showTextViewer(
  ctx: ExtensionCommandContext,
  record: AgentRecord,
  kind: "result" | "error",
  text: string,
): Promise<void> {
  const titleSuffix = kind === "result" ? record.id.slice(0, SHORT_ID_LENGTH) : "Error";
  const textLines = text.split("\n");
  const displayName = getDisplayName(record.display.type);
  const chromeLines = 5; // top border + title + sep + footer + bottom border
  const MIN_VIEWPORT = 3;
  const VIEWPORT_HEIGHT_PCT = 70;
  let scrollOffset = 0;
  let autoScroll = true;

  await ctx.ui.custom<void>(
    (tui, theme, _kb, done) => {
      const border = theme.fg("border", "│");

      const viewportHeight = () => {
        const maxRows = Math.floor((tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
        return Math.max(MIN_VIEWPORT, maxRows - chromeLines);
      };

      return {
        invalidate() {},
        render(width: number) {
          const innerW = width - 4;
          const out: string[] = [theme.fg("border", `\u256d${"\u2500".repeat(width - 2)}\u256e`)];

          // Title row: │ name · suffix pad │
          const titleStr = theme.bold(theme.fg("accent", `${displayName} \u00b7 ${titleSuffix}`));
          const titlePad = Math.max(0, innerW - visibleWidth(titleStr));
          out.push(`${border} ${truncateToWidth(titleStr + " ".repeat(titlePad), innerW, "...", true)} ${border}`);

          // Separator
          out.push(`${border} ${theme.fg("dim", "\u2500".repeat(innerW))} ${border}`);

          // Content with scrolling
          const vp = viewportHeight();
          const maxScroll = Math.max(0, textLines.length - vp);
          if (autoScroll) scrollOffset = maxScroll;
          const vs = Math.min(scrollOffset, maxScroll);
          const visible = textLines.slice(vs, vs + vp);

          for (let i = 0; i < vp; i++) {
            const line = visible[i] ?? "";
            const truncated = truncateToWidth(line, innerW, "...", true);
            const padLen = Math.max(0, innerW - visibleWidth(truncated));
            out.push(`${border} ${truncated}${" ".repeat(padLen)} ${border}`);
          }

          // Footer
          const scrollPct = textLines.length <= vp ? "100%" : `${Math.round(((vs + vp) / textLines.length) * 100)}%`;
          const count = theme.fg("dim", `${textLines.length} lines \u00b7 ${scrollPct}`);
          const footerText = theme.fg("dim", "q/Esc close");
          const gap = Math.max(1, innerW - visibleWidth(count) - visibleWidth(footerText));
          out.push(`${border} ${count}${" ".repeat(gap)}${footerText} ${border}`);

          out.push(theme.fg("border", `\u2570${"\u2500".repeat(width - 2)}\u256f`));
          return out;
        },
        handleInput(data: string) {
          if (matchesKey(data, "q") || matchesKey(data, "escape")) {
            done();
            return;
          }

          const vp = viewportHeight();
          const maxScroll = Math.max(0, textLines.length - vp);

          if (matchesKey(data, "up")) {
            scrollOffset = Math.max(0, scrollOffset - 1);
            autoScroll = scrollOffset >= maxScroll;
          } else if (matchesKey(data, "down")) {
            scrollOffset = Math.min(maxScroll, scrollOffset + 1);
            autoScroll = scrollOffset >= maxScroll;
          } else if (matchesKey(data, "pageUp")) {
            scrollOffset = Math.max(0, scrollOffset - vp);
            autoScroll = false;
          } else if (matchesKey(data, "pageDown")) {
            scrollOffset = Math.min(maxScroll, scrollOffset + vp);
            autoScroll = scrollOffset >= maxScroll;
          } else if (matchesKey(data, "home") || data === "g") {
            scrollOffset = 0;
            autoScroll = false;
          } else if (data === "G") {
            scrollOffset = maxScroll;
            autoScroll = true;
          }
        },
      };
    },
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
  setActive: (c: Component) => void,
  onClose: () => void,
): SelectList {
  const items: SelectItem[] = [];
  const shortId = record.id.slice(0, SHORT_ID_LENGTH);
  const isRunning = isActive(record);
  const hasSession = !!record.execution.session;
  const hasResult = !!record.result && record.result.length > 0;
  const hasError = !!record.error && record.error.length > 0;

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
    items.push({ value: "steer", label: "Steer" });
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
    if (item.value === "view-snapshot" || item.value === "view-conversation") {
      await showConversationViewer(ctx, record);
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
      ctx.ui.notify(`Stopped ${shortId}`, "info");
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
      const items: SelectItem[] = agents.map((record) => {
        const elapsed = Math.round((Date.now() - record.lifecycle.startedAt) / 1000);
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
        return {
          value: record.id,
          label: `${statusIcon} ${record.id.slice(0, SHORT_ID_LENGTH)}  ${record.display.type}  ${record.lifecycle.status}  ${elapsed}s${suffix}`,
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
        ctx.ui.notify(`Stopped ${running.length} agent(s)`, "info");
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
