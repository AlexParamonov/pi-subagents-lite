/**
 * agent-color.test.ts — Tests for agent badge color resolution and rendering.
 */

import { describe, it, expect } from "vitest";
import { resolveAgentColor, renderAgentNameLabel, themeForBadge, type AgentNameTheme } from "../src/agent-color.js";

/* ------------------------------------------------------------------ */
/*  Theme stubs                                                       */
/* ------------------------------------------------------------------ */

const passthroughTheme: AgentNameTheme = {
  fg: (_color, text) => text,
  bold: (text) => `**${text}**`,
};

const truecolorTheme: AgentNameTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
  getColorMode: () => "truecolor",
};

const color256Theme: AgentNameTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
  getColorMode: () => "256color",
};

/* ------------------------------------------------------------------ */
/*  resolveAgentColor                                                 */
/* ------------------------------------------------------------------ */

describe("resolveAgentColor", () => {
  it("returns undefined for undefined input", () => {
    expect(resolveAgentColor(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(resolveAgentColor("")).toBeUndefined();
  });

  it("returns uppercase hex for valid 6-digit hex", () => {
    expect(resolveAgentColor("#ff5733")).toBe("#FF5733");
  });

  it("normalizes named colors to hex", () => {
    expect(resolveAgentColor("red")).toBe("#DC2626");
    expect(resolveAgentColor("blue")).toBe("#6A9BCC");
    expect(resolveAgentColor("green")).toBe("#16A34A");
  });

  it("normalizes Agency Agents palette aliases", () => {
    expect(resolveAgentColor("amber")).toBe("#F59E0B");
    expect(resolveAgentColor("teal")).toBe("#008080");
    expect(resolveAgentColor("neon-green")).toBe("#10B981");
    expect(resolveAgentColor("neon-cyan")).toBe("#06B6D4");
    expect(resolveAgentColor("metallic-blue")).toBe("#3B82F6");
  });

  it("returns undefined for invalid color names", () => {
    expect(resolveAgentColor("beige")).toBeUndefined();
    expect(resolveAgentColor("chartreuse")).toBeUndefined();
  });

  it("returns undefined for invalid hex formats", () => {
    expect(resolveAgentColor("#FFF")).toBeUndefined();
    expect(resolveAgentColor("#12345")).toBeUndefined();
    expect(resolveAgentColor("#1234567")).toBeUndefined();
    expect(resolveAgentColor("123456")).toBeUndefined();
  });

  it("trims whitespace", () => {
    expect(resolveAgentColor("  red  ")).toBe("#DC2626");
    expect(resolveAgentColor("  #FF5733  ")).toBe("#FF5733");
  });

  it("is case-insensitive for named colors", () => {
    expect(resolveAgentColor("RED")).toBe("#DC2626");
    expect(resolveAgentColor("Red")).toBe("#DC2626");
  });
});

/* ------------------------------------------------------------------ */
/*  themeForBadge                                                     */
/* ------------------------------------------------------------------ */

describe("themeForBadge", () => {
  it("wraps Theme into AgentNameTheme", () => {
    const mockTheme = {
      fg: (color: string, text: string) => `<fg:${color}>${text}</fg>`,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => `<b>${text}</b>`,
    };
    const badgeTheme = themeForBadge(mockTheme);
    expect(badgeTheme.fg("accent", "hello")).toBe("<fg:accent>hello</fg>");
    expect(badgeTheme.bold("hi")).toBe("<b>hi</b>");
  });

  it("defaults to truecolor mode", () => {
    const mockTheme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const badgeTheme = themeForBadge(mockTheme);
    expect(badgeTheme.getColorMode?.()).toBe("truecolor");
  });
});

/* ------------------------------------------------------------------ */
/*  renderAgentNameLabel — badge rendering                             */
/* ------------------------------------------------------------------ */

describe("renderAgentNameLabel", () => {
  it("renders plain text when color is undefined", () => {
    const result = renderAgentNameLabel("Agent", undefined, passthroughTheme);
    expect(result).toBe("Agent");
  });

  it("renders plain text when color is invalid", () => {
    const result = renderAgentNameLabel("Agent", "beige", passthroughTheme);
    expect(result).toBe("Agent");
  });

  it("applies bold when style.bold is true and no valid color", () => {
    const result = renderAgentNameLabel("Agent", undefined, passthroughTheme, { bold: true });
    expect(result).toBe("**Agent**");
  });

  it("applies fallbackColor when no valid color", () => {
    const result = renderAgentNameLabel("Agent", undefined, passthroughTheme, {
      fallbackColor: "accent",
    });
    // fallbackColor path calls theme.fg("accent", "Agent") which returns "Agent" in passthrough
    expect(result).toBe("Agent");
  });

  it("renders badge with truecolor ANSI for valid named color", () => {
    const result = renderAgentNameLabel("Builder", "red", truecolorTheme);
    // Should contain background color ANSI (48;2;...) for red #DC2626 = rgb(220,38,38)
    expect(result).toContain("\u001b[48;2;220;38;38m");
    // Should contain foreground ANSI for contrasting color (white, since red is dark)
    expect(result).toContain("\u001b[38;2;255;255;255m");
    // Should contain the padded name
    expect(result).toContain(" Builder ");
    // Should end with foreground reset and background reset
    expect(result).toContain("\u001b[39m");
    expect(result).toContain("\u001b[49m");
  });

  it("renders badge with truecolor ANSI for valid hex color", () => {
    const result = renderAgentNameLabel("Tester", "#FF5733", truecolorTheme);
    // #FF5733 = rgb(255,87,51)
    expect(result).toContain("\u001b[48;2;255;87;51m");
    expect(result).toContain(" Tester ");
  });

  it("uses black text for bright backgrounds (WCAG contrast)", () => {
    // #FFFF00 (yellow) is very bright → luminance > 0.179 → black text
    const result = renderAgentNameLabel("Bright", "#FFFF00", truecolorTheme);
    expect(result).toContain("\u001b[38;2;0;0;0m");
  });

  it("uses white text for dark backgrounds (WCAG contrast)", () => {
    // #000000 (black) → luminance ≈ 0 → white text
    const result = renderAgentNameLabel("Dark", "#000000", truecolorTheme);
    expect(result).toContain("\u001b[38;2;255;255;255m");
  });

  it("quantizes to 256-color when theme reports 256color mode", () => {
    const result = renderAgentNameLabel("Builder", "red", color256Theme);
    // Should contain 256-color background ANSI (48;5;...)
    expect(result).toMatch(/\u001b\[48;5;\d+m/);
    // Should contain 256-color foreground ANSI (38;5;...)
    expect(result).toMatch(/\u001b\[38;5;\d+m/);
    // Should NOT contain truecolor ANSI
    expect(result).not.toMatch(/\u001b\[48;2;/);
  });

  it("applies bold inside the badge when style.bold is true", () => {
    const result = renderAgentNameLabel("Agent", "blue", truecolorTheme, { bold: true });
    // Bold wraps " Agent " — in passthrough theme bold returns **text**
    // With truecolorTheme, bold is passthrough, so text is " Agent "
    expect(result).toContain(" Agent ");
  });

  it("uses restoreBackground instead of default reset when provided", () => {
    const result = renderAgentNameLabel("X", "red", truecolorTheme, {
      restoreBackground: "\u001b[48;2;30;30;30m",
    });
    // Should end with custom restore, not default 49m
    expect(result).toContain("\u001b[48;2;30;30;30m");
    expect(result).not.toContain("\u001b[49m");
  });
});

/* ------------------------------------------------------------------ */
/*  256-color quantization internals (via renderAgentNameLabel)        */
/* ------------------------------------------------------------------ */

describe("256-color quantization", () => {
  it("quantizes near-neutral colors to the gray ramp", () => {
    // #808080 is neutral gray → should use gray ramp (index 232+)
    const result = renderAgentNameLabel("Gray", "#808080", color256Theme);
    expect(result).toMatch(/\u001b\[48;5;(\d+)m/);
    const match = result.match(/\u001b\[48;5;(\d+)m/);
    const index = Number(match?.[1]);
    // Gray ramp starts at index 232
    expect(index).toBeGreaterThanOrEqual(232);
  });

  it("quantizes saturated colors to the color cube", () => {
    // Pure red → should use color cube, not gray ramp
    const result = renderAgentNameLabel("Red", "#FF0000", color256Theme);
    const match = result.match(/\u001b\[48;5;(\d+)m/);
    const index = Number(match?.[1]);
    // Color cube starts at index 16
    expect(index).toBeGreaterThanOrEqual(16);
    expect(index).toBeLessThan(232);
  });
});
