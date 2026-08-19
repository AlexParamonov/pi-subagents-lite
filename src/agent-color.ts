/**
 * agent-color.ts — Agent color resolution and ANSI output.
 *
 * Resolves agent color from config (named colors, hex) and produces
 * raw ANSI foreground escape codes for icon tinting.
 */

import { getAgentConfig } from "./agents/agent-types.js";

// ---- Named color map ----

/** 8 Claude Code named colors + 14 Agency Agents palette aliases. */
const NAMED_COLORS: Record<string, string> = {
  // Claude Code's eight subagent colors, as its default theme renders them.
  red: "#DC2626",
  blue: "#6A9BCC",
  green: "#16A34A",
  yellow: "#CA8A04",
  purple: "#827DBD",
  orange: "#D97757",
  pink: "#C46686",
  cyan: "#0891B2",
  // Agency Agents palette aliases.
  amber: "#F59E0B",
  teal: "#008080",
  indigo: "#6366F1",
  gold: "#EAB308",
  "neon-green": "#10B981",
  "neon-cyan": "#06B6D4",
  "metallic-blue": "#3B82F6",
  violet: "#8B5CF6",
  rose: "#F43F5E",
  lime: "#84CC16",
  gray: "#6B7280",
  grey: "#6B7280",
  fuchsia: "#D946EF",
  slate: "#64748B",
  navy: "#1E3A8A",
};

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

// ---- Public API ----

/**
 * Resolve a color value (name or hex) to a 6-digit hex string.
 * Returns undefined for invalid/missing values.
 */
export function resolveAgentColor(value: string | undefined): string | undefined {
  if (!value || value.length === 0) return undefined;

  // Named color
  const named = NAMED_COLORS[value.toLowerCase()];
  if (named) return named;

  // 6-digit hex
  if (HEX_PATTERN.test(value)) return value;

  return undefined;
}

/**
 * Convert a hex color string to a raw ANSI 24-bit foreground escape code.
 * Returns empty string for undefined/empty input.
 */
export function hexToAnsi(hex: string | undefined): string {
  if (!hex || hex.length === 0) return "";

  const match = HEX_PATTERN.exec(hex);
  if (!match) return "";

  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Get a raw ANSI foreground escape code for an agent type's configured color.
 * Looks up the agent config, resolves the color, and converts to ANSI.
 * Returns empty string if the agent has no color or is unknown.
 */
export function agentColorAnsi(type: string | undefined): string {
  if (!type || type.length === 0) return "";
  const config = getAgentConfig(type);
  if (!config?.color) return "";
  const hex = resolveAgentColor(config.color);
  return hexToAnsi(hex);
}
