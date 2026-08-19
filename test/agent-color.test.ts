/**
 * agent-color.test.ts — Tests for agent color resolution and ANSI output.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { resolveAgentColor, hexToAnsi, agentColorAnsi } from "../src/agent-color.js";
import { registerAgents } from "../src/agents/agent-types.js";
import type { AgentConfig } from "../src/agents/types.js";

const HEX_RE = /^#[0-9A-F]{6}$/;

describe("resolveAgentColor", () => {
  describe("named colors", () => {
    it.each(["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"])(
      "resolves '%s' to a valid hex",
      (name) => {
        const hex = resolveAgentColor(name);
        expect(hex).toMatch(HEX_RE);
      },
    );

    it("is case-insensitive", () => {
      expect(resolveAgentColor("RED")).toBe(resolveAgentColor("red"));
      expect(resolveAgentColor("Red")).toBe(resolveAgentColor("red"));
    });
  });

  describe("agency agents palette aliases", () => {
    it.each(["amber", "teal", "indigo", "gold", "neon-green", "neon-cyan", "metallic-blue", "violet", "rose", "lime", "gray", "grey", "fuchsia", "slate", "navy"])(
      "resolves '%s' to a valid hex",
      (name) => {
        const hex = resolveAgentColor(name);
        expect(hex).toMatch(HEX_RE);
      },
    );
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
    expect(result).toMatch(/^\x1b\[38;2;\d+;\d+;\d+m$/);
  });

  it("returns ANSI escape for agent with hex color", () => {
    const result = agentColorAnsi("hex-agent");
    expect(result).toMatch(/^\x1b\[38;2;\d+;\d+;\d+m$/);
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
