/**
 * agent-color.test.ts — Tests for agent color resolution and ANSI output.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { resolveAgentColor, hexToAnsi, agentColorAnsi } from "../src/agent-color.js";
import { registerAgents } from "../src/agents/agent-types.js";
import type { AgentConfig } from "../src/agents/types.js";

describe("resolveAgentColor", () => {
  describe("named colors", () => {
    it.each([
      ["red", "#DC2626"],
      ["blue", "#6A9BCC"],
      ["green", "#16A34A"],
      ["yellow", "#CA8A04"],
      ["purple", "#827DBD"],
      ["orange", "#D97757"],
      ["pink", "#C46686"],
      ["cyan", "#0891B2"],
    ])("resolves '%s' to %s", (name, hex) => {
      expect(resolveAgentColor(name)).toBe(hex);
    });

    it("is case-insensitive", () => {
      expect(resolveAgentColor("RED")).toBe("#DC2626");
      expect(resolveAgentColor("Red")).toBe("#DC2626");
    });
  });

  describe("agency agents palette aliases", () => {
    it.each([
      ["amber", "#F59E0B"],
      ["teal", "#008080"],
      ["indigo", "#6366F1"],
      ["gold", "#EAB308"],
      ["neon-green", "#10B981"],
      ["neon-cyan", "#06B6D4"],
      ["metallic-blue", "#3B82F6"],
      ["violet", "#8B5CF6"],
      ["rose", "#F43F5E"],
      ["lime", "#84CC16"],
      ["gray", "#6B7280"],
      ["grey", "#6B7280"],
      ["fuchsia", "#D946EF"],
      ["slate", "#64748B"],
      ["navy", "#1E3A8A"],
    ])("resolves '%s' to %s", (name, hex) => {
      expect(resolveAgentColor(name)).toBe(hex);
    });
  });

  describe("hex colors", () => {
    it("returns 6-digit hex unchanged", () => {
      expect(resolveAgentColor("#FF5733")).toBe("#FF5733");
    });

    it("returns lowercase hex unchanged", () => {
      expect(resolveAgentColor("#aabbcc")).toBe("#aabbcc");
    });
  });

  describe("invalid/missing", () => {
    it("returns undefined for undefined", () => {
      expect(resolveAgentColor(undefined)).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
      expect(resolveAgentColor("")).toBeUndefined();
    });

    it("returns undefined for unknown named color", () => {
      expect(resolveAgentColor("notacolor")).toBeUndefined();
    });

    it("returns undefined for invalid hex (too short)", () => {
      expect(resolveAgentColor("#fff")).toBeUndefined();
    });

    it("returns undefined for invalid hex (no hash)", () => {
      expect(resolveAgentColor("FF5733")).toBeUndefined();
    });

    it("returns undefined for invalid hex (8-digit)", () => {
      expect(resolveAgentColor("#FF573300")).toBeUndefined();
    });
  });
});

describe("hexToAnsi", () => {
  it("converts hex to 24-bit ANSI foreground escape", () => {
    const result = hexToAnsi("#FF5733");
    expect(result).toBe("\x1b[38;2;255;87;51m");
  });

  it("handles lowercase hex", () => {
    const result = hexToAnsi("#00ff00");
    expect(result).toBe("\x1b[38;2;0;255;0m");
  });

  it("returns empty string for undefined", () => {
    expect(hexToAnsi(undefined)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(hexToAnsi("")).toBe("");
  });

  it("returns empty string for invalid hex", () => {
    expect(hexToAnsi("#xyz")).toBe("");
  });
});

describe("agentColorAnsi", () => {
  beforeEach(() => {
    registerAgents(
      new Map<string, AgentConfig>([
        ["color-agent", { name: "color-agent", description: "Has color", color: "red", systemPrompt: "" }],
        ["hex-agent", { name: "hex-agent", description: "Has hex color", color: "#FF5733", systemPrompt: "" }],
        ["no-color-agent", { name: "no-color-agent", description: "No color", systemPrompt: "" }],
      ]),
    );
  });

  it("returns ANSI escape for agent with named color", () => {
    const result = agentColorAnsi("color-agent");
    // red → #DC2626 → rgb(220, 38, 38)
    expect(result).toBe("\x1b[38;2;220;38;38m");
  });

  it("returns ANSI escape for agent with hex color", () => {
    const result = agentColorAnsi("hex-agent");
    expect(result).toBe("\x1b[38;2;255;87;51m");
  });

  it("returns empty string for agent without color", () => {
    expect(agentColorAnsi("no-color-agent")).toBe("");
  });

  it("returns empty string for unknown agent type", () => {
    expect(agentColorAnsi("nonexistent")).toBe("");
  });

  it("returns empty string for undefined type", () => {
    expect(agentColorAnsi(undefined)).toBe("");
  });

  it("returns empty string for empty type", () => {
    expect(agentColorAnsi("")).toBe("");
  });
});
