/**
 * helpers.test.ts — Tests for ui/menu/helpers.ts.
 */

import { describe, it, expect } from "vitest";
import {
  installSeparatorSkip,
  validateNumeric,
  buildSettingsListTheme,
  buildSelectListTheme,
} from "../../../src/ui/menu/helpers.js";

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

  it("returns undefined for input with a non-numeric suffix", () => {
    expect(validateNumeric("12x", 0)).toBeUndefined();
  });

  it("returns parsed float for decimal input", () => {
    expect(validateNumeric("12.5", 0)).toBe(12.5);
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

  it("description uses dim", () => {
    const theme = buildSettingsListTheme(mockTheme);
    expect(theme.description("desc")).toBe("[dim:desc]");
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

describe("installSeparatorSkip", () => {
  function makeList(items: any[]) {
    return { items, selectedIndex: 0 };
  }

  it("skips a __sep__ row when moving down onto it (SettingsList items use id)", () => {
    const list = makeList([
      { id: "a", label: "A", currentValue: "" },
      { id: "__sep__", label: " ", currentValue: "" },
      { id: "b", label: "B", currentValue: "" },
    ]);
    installSeparatorSkip(list);
    list.selectedIndex = 1; // library write for down from "a"
    expect(list.items[list.selectedIndex].id).toBe("b");
  });

  it("skips a __sep__ row when moving up onto it (SelectList items use value)", () => {
    const list = makeList([
      { value: "a", label: "A" },
      { value: "__sep__", label: " " },
      { value: "b", label: "B" },
    ]);
    installSeparatorSkip(list);
    list.selectedIndex = 2;
    list.selectedIndex = 1; // library write for up from "b"
    expect(list.items[list.selectedIndex].value).toBe("a");
  });

  it("falls back to the opposite direction when the travel direction hits a trailing separator", () => {
    const list = makeList([
      { id: "a", label: "A", currentValue: "" },
      { id: "b", label: "B", currentValue: "" },
      { id: "__sep__", label: " ", currentValue: "" },
    ]);
    installSeparatorSkip(list);
    list.selectedIndex = 5; // out-of-range write, clamped to the trailing sep
    expect(list.items[list.selectedIndex].id).toBe("b");
  });

  it("falls forward past a leading separator when wrap-around writes 0", () => {
    const list = makeList([
      { id: "__sep__", label: " ", currentValue: "" },
      { id: "a", label: "A", currentValue: "" },
      { id: "b", label: "B", currentValue: "" },
    ]);
    installSeparatorSkip(list);
    list.selectedIndex = 0; // library write for down from the last item
    expect(list.items[list.selectedIndex].id).toBe("a");
  });

  it("stays put when every item is a separator", () => {
    const list = makeList([
      { id: "__sep__", label: " ", currentValue: "" },
      { id: "__sep__", label: " ", currentValue: "" },
    ]);
    installSeparatorSkip(list);
    list.selectedIndex = 1;
    expect(list.items[list.selectedIndex].id).toBe("__sep__");
  });

  it("is a no-op when items is not an array", () => {
    const list = { selectedIndex: 0 };
    expect(() => installSeparatorSkip(list)).not.toThrow();
  });
});
