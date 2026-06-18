/**
 * helpers.test.ts — Tests for ui/menu/helpers.ts.
 */

import { describe, it, expect } from "vitest";
import { validateNumeric, buildSettingsListTheme, buildSelectListTheme } from "../../../src/ui/menu/helpers.js";

const mockTheme = {
  fg: (color: string, text: string) => `[${color}:${text}]`,
  bold: (text: string) => `**${text}**`,
};

describe("validateNumeric", () => {
  it("returns parsed integer for valid input", () => {
    expect(validateNumeric("10", 2)).toBe(10);
  });

  it("returns parsed integer at minimum boundary", () => {
    expect(validateNumeric("2", 2)).toBe(2);
  });

  it("returns undefined for value below minimum", () => {
    expect(validateNumeric("1", 2)).toBeUndefined();
  });

  it("returns undefined for non-numeric input", () => {
    expect(validateNumeric("abc", 2)).toBeUndefined();
  });

  it("trims whitespace before parsing", () => {
    expect(validateNumeric("  10  ", 2)).toBe(10);
  });

  it("returns undefined for empty string", () => {
    expect(validateNumeric("", 2)).toBeUndefined();
  });

  it("handles min of 1", () => {
    expect(validateNumeric("1", 1)).toBe(1);
    expect(validateNumeric("0", 1)).toBeUndefined();
  });
});

describe("buildSettingsListTheme", () => {
  it("returns an object with all required SettingsListTheme properties", () => {
    const theme = buildSettingsListTheme(mockTheme);
    expect(typeof theme.label).toBe("function");
    expect(typeof theme.value).toBe("function");
    expect(typeof theme.description).toBe("function");
    expect(typeof theme.cursor).toBe("string");
    expect(typeof theme.hint).toBe("function");
  });

  it("label applies accent when selected", () => {
    const theme = buildSettingsListTheme(mockTheme);
    expect(theme.label("test", true)).toBe("[accent:test]");
  });

  it("label returns plain text when not selected", () => {
    const theme = buildSettingsListTheme(mockTheme);
    expect(theme.label("test", false)).toBe("test");
  });

  it("value uses accent when selected", () => {
    const theme = buildSettingsListTheme(mockTheme);
    expect(theme.value("val", true)).toBe("[accent:val]");
  });

  it("value uses muted when not selected", () => {
    const theme = buildSettingsListTheme(mockTheme);
    expect(theme.value("val", false)).toBe("[muted:val]");
  });

  it("description uses muted", () => {
    const theme = buildSettingsListTheme(mockTheme);
    expect(theme.description("desc")).toBe("[muted:desc]");
  });

  it("cursor uses accent", () => {
    const theme = buildSettingsListTheme(mockTheme);
    expect(theme.cursor).toBe("[accent:→ ]");
  });

  it("hint uses dim", () => {
    const theme = buildSettingsListTheme(mockTheme);
    expect(theme.hint("hint")).toBe("[dim:hint]");
  });
});

describe("buildSelectListTheme", () => {
  it("returns a SelectListTheme with all required properties", () => {
    const theme = buildSelectListTheme(mockTheme);
    expect(typeof theme.selectedPrefix).toBe("function");
    expect(typeof theme.selectedText).toBe("function");
    expect(typeof theme.description).toBe("function");
    expect(typeof theme.scrollInfo).toBe("function");
    expect(typeof theme.noMatch).toBe("function");
  });

  it("selectedPrefix uses accent color and cursor arrow", () => {
    const theme = buildSelectListTheme(mockTheme);
    expect(theme.selectedPrefix("item")).toBe("[accent:→ ]");
  });

  it("selectedText uses accent color", () => {
    const theme = buildSelectListTheme(mockTheme);
    expect(theme.selectedText("text")).toBe("[accent:text]");
  });

  it("description uses muted", () => {
    const theme = buildSelectListTheme(mockTheme);
    expect(theme.description("desc")).toBe("[muted:desc]");
  });

  it("produces identical cursor style to buildSettingsListTheme", () => {
    const settingsTheme = buildSettingsListTheme(mockTheme);
    const selectTheme = buildSelectListTheme(mockTheme);
    expect(selectTheme.selectedPrefix("item")).toBe(settingsTheme.cursor);
  });
});
