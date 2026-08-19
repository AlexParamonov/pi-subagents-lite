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
  // Claude Code colors
  red: "#ff0000",
  green: "#00ff00",
  blue: "#0000ff",
  yellow: "#ffff00",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  white: "#ffffff",
  gray: "#808080",
  // Agency Agents palette
  coral: "#ff7f50",
  teal: "#008080",
  violet: "#9400d3",
  amber: "#ffbf00",
  emerald: "#50c878",
  rose: "#ff007f",
  indigo: "#4b0082",
  chartreuse: "#7fff00",
  cerulean: "#007ba7",
  crimson: "#dc143c",
  lavender: "#e6e6fa",
  ochre: "#cc7722",
  sienna: "#a0522d",
  cobalt: "#0047ab",
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
