/**
 * Tests for buildSelectListTheme in menu-helpers.ts.
 */

import { describe, it, expect } from "vitest";
import { buildSelectListTheme, buildSettingsListTheme } from "../src/ui/menu/menu-helpers.js";

const mockTheme = {
  fg: (color: string, text: string) => `[${color}]${text}`,
  bold: (text: string) => `*${text}*`,
  italic: (text: string) => `_${text}_`,
};

describe("buildSelectListTheme", () => {
  it("returns a SelectListTheme with all required properties", () => {
    const theme = buildSelectListTheme(mockTheme);
    expect(typeof theme.selectedPrefix).toBe("function");
    expect(typeof theme.selectedText).toBe("function");
    expect(typeof theme.description).toBe("function");
    expect(typeof theme.scrollInfo).toBe("function");
    expect(typeof theme.noMatch).toBe("function");
  });

  it("selectedPrefix uses accent color and > cursor", () => {
    const theme = buildSelectListTheme(mockTheme);
    const result = theme.selectedPrefix("test");
    expect(result).toContain("→");
    expect(result).toContain("accent");
  });

  it("selectedText uses accent color", () => {
    const theme = buildSelectListTheme(mockTheme);
    const result = theme.selectedText("item label");
    expect(result).toContain("accent");
    expect(result).toContain("item label");
    expect(result).not.toContain("*"); // no bold
  });

  it("non-selected text is plain (no bold)", () => {
    const theme = buildSelectListTheme(mockTheme);
    const result = theme.description("some desc");
    expect(result).toContain("muted");
    expect(result).toContain("some desc");
  });

  it("produces identical cursor style to buildSettingsListTheme", () => {
    const selectTheme = buildSelectListTheme(mockTheme);
    const settingsTheme = buildSettingsListTheme(mockTheme);
    // Both should produce the same accent-colored cursor prefix
    expect(selectTheme.selectedPrefix("")).toBe(settingsTheme.cursor);
  });
});
