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
      ["red", "#ff0000"],
      ["green", "#00ff00"],
      ["blue", "#0000ff"],
      ["yellow", "#ffff00"],
      ["cyan", "#00ffff"],
      ["magenta", "#ff00ff"],
      ["white", "#ffffff"],
      ["gray", "#808080"],
    ])("resolves '%s' to %s", (name, hex) => {
      expect(resolveAgentColor(name)).toBe(hex);
    });

    it("is case-insensitive", () => {
      expect(resolveAgentColor("RED")).toBe("#ff0000");
      expect(resolveAgentColor("Red")).toBe("#ff0000");
    });
  });

  describe("agency agents palette aliases", () => {
    it.each([
      ["coral", "#ff7f50"],
      ["teal", "#008080"],
      ["violet", "#9400d3"],
      ["amber", "#ffbf00"],
      ["emerald", "#50c878"],
      ["rose", "#ff007f"],
      ["indigo", "#4b0082"],
      ["chartreuse", "#7fff00"],
      ["cerulean", "#007ba7"],
      ["crimson", "#dc143c"],
      ["lavender", "#e6e6fa"],
      ["ochre", "#cc7722"],
      ["sienna", "#a0522d"],
      ["cobalt", "#0047ab"],
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
    expect(result).toBe("\x1b[38;2;255;0;0m");
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
