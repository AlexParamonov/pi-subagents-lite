/**
 * renderer.ts — Rendering helpers for the Agent tool and subagent-result messages.
 *
 * Extracted from index.ts to separate display concerns from extension wiring.
 */

import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Theme } from "./types.js";
import { buildStatsCells, formatStatsRow, formatThinkingTag, getAgentStatusDisplay, getDisplayName } from "./format.js";
import type { AgentStatus } from "../types.js";

// ============================================================================
// Stats rendering helpers
// ============================================================================

/** Format agent display name with optional model and thinking level. */
export function agentNameLabel(d: Record<string, unknown>, theme: Theme): string {
  const typeName = getDisplayName((d.type as string) || "");
  const modelName = typeof d.modelName === "string" && d.modelName.trim() ? d.modelName.trim() : undefined;
  const thinkingTag = formatThinkingTag(d.thinkingLevel);
  const label = [modelName, thinkingTag].filter((part): part is string => part !== undefined).join(" · ");
  return label ? `${theme.bold(typeName)} (${label})` : theme.bold(typeName);
}

/** Build the stats line for an agent result card. */
export function buildStatsLine(d: Record<string, unknown>, theme: Theme, showCost: boolean): string {
  const cells = buildStatsCells({
    toolUses: (d.toolUses as number) ?? 0,
    turnCount: d.turnCount as number | undefined,
    maxTurns: d.maxTurns as number | undefined,
    input: (d.input as number) ?? 0,
    output: (d.output as number) ?? 0,
    cacheRead: d.cacheRead as number | undefined,
    cacheWrite: d.cacheWrite as number | undefined,
    latestCacheHitRate: d.latestCacheHitRate as number | undefined,
    contextPercent: d.contextPercent as number | null,
    contextWindow: d.contextWindow as number | undefined,
    autoCompactionEnabled: d.autoCompactionEnabled as boolean | undefined,
    cost: showCost ? (d.cost as number | undefined) : undefined,
    usingSubscription: showCost ? (d.usingSubscription as boolean | undefined) : undefined,
    durationMs: d.durationMs as number,
  }, theme);
  return formatStatsRow(cells) ?? "";
}

// ============================================================================
// Agent tool renderers
// ============================================================================

/** Render the Agent tool call line (e.g., "▸ Agent (model)"). */
export function renderAgentToolCall(
  args: Record<string, unknown>,
  theme: Theme,
): Text {
  const typeName = getDisplayName((args.agent as string) || "");
  const label = typeName || "Agent";
  let text = `▸ ${theme.fg("accent", theme.bold(label))}`;

  const modelOverride = typeof args._modelOverride === "string" && args._modelOverride.trim()
    ? args._modelOverride.trim()
    : undefined;
  const thinkingTag = formatThinkingTag(args.thinking);
  const details = [modelOverride, thinkingTag].filter((part): part is string => part !== undefined).join(" · ");
  if (details) text += ` (${details})`;

  return new Text(text, 0, 0);
}

/** Render the Agent tool result — compact or expanded. */
export function renderAgentToolResult(
  result: { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; isError?: boolean },
  options: { expanded?: boolean },
  theme: Theme,
  showCost: boolean,
): Text {
  const { expanded } = options;
  const text = result.content[0]?.type === "text" ? result.content[0].text ?? "" : "";
  const d = result.details;
  const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
  const desc = (d?.description as string) || "";

  if (d && d.turnCount != null) {
    const namePart = agentNameLabel(d, theme);
    const statsLine = buildStatsLine(d, theme, showCost);
    let lines = `${icon} ${namePart} · ${statsLine}\n  ${theme.fg("text", desc)}`;
    if (expanded && text) {
      lines += "\n" + text.split("\n").map(l => `  ${l}`).join("\n");
    }
    return new Text(lines, 0, 0);
  }

  // Minimal card — background spawns (no stats) use space placeholder
  const isBackground = text.includes("running in background") || text.includes("queued");
  const prefix = isBackground ? "  " : `${icon} `;
  if (desc) {
    return new Text(`${prefix}${theme.fg("text", desc)}`, 0, 0);
  }

  return new Text(`${prefix}${theme.fg("dim", text)}`, 0, 0);
}

// ============================================================================
// Message renderer — subagent-result (background agent completion)
// ============================================================================

/** Render a subagent-result message injected after background agent completion. */
export function renderSubagentResult(
  message: { content?: string; details?: Record<string, unknown> },
  options: { expanded?: boolean },
  theme: Theme,
  showCost: boolean,
): Container {
  const { expanded } = options;
  const d = message.details;
  const text = (message.content as string)?.trim() || "";

  const inner = new Container();
  inner.addChild(new Text(theme.fg("customMessageLabel", "Subagent Result"), 0, 0));
  inner.addChild(new Spacer(1));

  if (d && d.turnCount != null) {
    const status = (d.status as AgentStatus | undefined) ?? "completed";
    const { icon, color } = getAgentStatusDisplay(status);
    const statusIcon = theme.fg(color, icon);

    const namePart = agentNameLabel(d, theme);
    const statsLine = buildStatsLine(d, theme, showCost);
    let headerLine = `${statusIcon} ${namePart} · ${statsLine}\n  ${theme.fg("text", (d.description as string) || "")}`;
    if (d.outputFile as string) {
      headerLine += `\n  ${theme.fg("dim", `tail -f ${d.outputFile}`)}`;
    }
    if (d.worktreePath as string) {
      headerLine += `\n  ${theme.fg("dim", `worktree: ${d.worktreePath}`)}`;
    }
    inner.addChild(new Text(headerLine, 0, 0));

    if (expanded && text) {
      inner.addChild(new Spacer(1));
      inner.addChild(new Text(text.split("\n").map(l => `  ${l}`).join("\n"), 0, 0));
    }
  } else {
    inner.addChild(new Text(buildFallbackResultLine(d, text, theme), 0, 0));
  }

  const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
  box.addChild(inner);

  const outer = new Container();
  outer.addChild(new Spacer(1));
  outer.addChild(box);
  outer.addChild(new Spacer(1));
  return outer;
}

/** Build a fallback result line for subagent-result messages without stats. */
function buildFallbackResultLine(
  d: Record<string, unknown> | undefined,
  text: string,
  theme: Theme,
): string {
  const status = (d?.status as AgentStatus | undefined) ?? "completed";
  const { icon, color } = getAgentStatusDisplay(status);
  let line = theme.fg(color, icon);
  if (d?.type) {
    line += ` ${agentNameLabel(d, theme)}`;
  }
  const desc = (d?.description as string) || "";
  if (desc) line += `\n  ${theme.fg("text", desc)}`;
  if (d?.outputFile) {
    line += `\n  ${theme.fg("dim", `tail -f ${d.outputFile}`)}`;
  }
  if (d?.worktreePath) {
    line += `\n  ${theme.fg("dim", `worktree: ${d.worktreePath}`)}`;
  }
  return line;
}
