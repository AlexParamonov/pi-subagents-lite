/**
 * helpers.test.ts — Tests for ui/menu/helpers.ts.
 */

import { describe, it, expect } from "vitest";
import {
  installSeparatorSkip,
  validateNumeric,
  buildSettingsListTheme,
  buildSelectListTheme,
  buildModelOptions,
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
  /** A menu row the separator-skip helper navigates over. SettingsList and
   * SelectList items carry different identity keys (id vs value); the helper
   * duck-types both, so the row shape unions them. */
  interface MenuRow {
    id?: string;
    value?: string;
    label: string;
    currentValue?: string;
  }

  function makeList(items: MenuRow[]) {
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

  it("preserves a selection made before installation", () => {
    const list = makeList([
      { id: "a", label: "A", currentValue: "" },
      { id: "b", label: "B", currentValue: "" },
    ]);
    list.selectedIndex = 1;
    installSeparatorSkip(list);
    expect(list.selectedIndex).toBe(1);
  });

  it("is a no-op when items is not an array", () => {
    const list = { selectedIndex: 0 };
    expect(() => installSeparatorSkip(list)).not.toThrow();
  });
});

describe("buildModelOptions", () => {
  const rawOptions = ["anthropic/claude-3.5-sonnet", "openai/gpt-4o", "anthropic/claude-3-haiku"];

  it("returns inherits parent as first option", () => {
    const result = buildModelOptions(rawOptions);
    expect(result[0]).toEqual({ value: "(inherits parent)", label: "(inherits parent)", provider: "" });
  });

  it("parses model options correctly", () => {
    const result = buildModelOptions(rawOptions);
    expect(result).toHaveLength(4); // inherits + 3 models
    expect(result[1]).toEqual({
      value: "anthropic/claude-3.5-sonnet",
      label: "claude-3.5-sonnet",
      provider: "anthropic",
    });
    expect(result[2]).toEqual({ value: "openai/gpt-4o", label: "gpt-4o", provider: "openai" });
    expect(result[3]).toEqual({ value: "anthropic/claude-3-haiku", label: "claude-3-haiku", provider: "anthropic" });
  });

  describe("sorting with currentModel and configuredModels", () => {
    it("places current model first after inherits parent", () => {
      const result = buildModelOptions(rawOptions, "openai/gpt-4o");
      expect(result.map((r) => r.value)).toEqual([
        "(inherits parent)",
        "openai/gpt-4o",
        "anthropic/claude-3.5-sonnet",
        "anthropic/claude-3-haiku",
      ]);
    });

    it("places configured models after current model", () => {
      const result = buildModelOptions(rawOptions, "openai/gpt-4o", ["anthropic/claude-3.5-sonnet"]);
      expect(result.map((r) => r.value)).toEqual([
        "(inherits parent)",
        "openai/gpt-4o",
        "anthropic/claude-3.5-sonnet",
        "anthropic/claude-3-haiku",
      ]);
    });

    it("places configured models first when no current model", () => {
      const result = buildModelOptions(rawOptions, undefined, ["anthropic/claude-3.5-sonnet"]);
      expect(result.map((r) => r.value)).toEqual([
        "(inherits parent)",
        "anthropic/claude-3.5-sonnet",
        "openai/gpt-4o",
        "anthropic/claude-3-haiku",
      ]);
    });

    it("handles multiple configured models", () => {
      const result = buildModelOptions(rawOptions, undefined, ["openai/gpt-4o", "anthropic/claude-3-haiku"]);
      expect(result.map((r) => r.value)).toEqual([
        "(inherits parent)",
        "openai/gpt-4o",
        "anthropic/claude-3-haiku",
        "anthropic/claude-3.5-sonnet",
      ]);
    });

    it("preserves original order within configured models", () => {
      // Config order is haiku, then sonnet
      const result = buildModelOptions(rawOptions, undefined, [
        "anthropic/claude-3-haiku",
        "anthropic/claude-3.5-sonnet",
      ]);
      expect(result.map((r) => r.value)).toEqual([
        "(inherits parent)",
        "anthropic/claude-3-haiku",
        "anthropic/claude-3.5-sonnet",
        "openai/gpt-4o",
      ]);
    });

    it("degrades gracefully with no current model and no configured models", () => {
      const result = buildModelOptions(rawOptions);
      expect(result.map((r) => r.value)).toEqual([
        "(inherits parent)",
        "anthropic/claude-3.5-sonnet",
        "openai/gpt-4o",
        "anthropic/claude-3-haiku",
      ]);
    });

    it("current model that is also configured appears only once", () => {
      const result = buildModelOptions(rawOptions, "openai/gpt-4o", ["openai/gpt-4o"]);
      expect(result.map((r) => r.value)).toEqual([
        "(inherits parent)",
        "openai/gpt-4o",
        "anthropic/claude-3.5-sonnet",
        "anthropic/claude-3-haiku",
      ]);
    });

    it("current model not in raw options appears at top", () => {
      const result = buildModelOptions(rawOptions, "google/gemini-pro");
      expect(result.map((r) => r.value)).toEqual([
        "(inherits parent)",
        "google/gemini-pro",
        "anthropic/claude-3.5-sonnet",
        "openai/gpt-4o",
        "anthropic/claude-3-haiku",
      ]);
    });

    it("configured model not in raw options appears after current", () => {
      const result = buildModelOptions(rawOptions, undefined, ["google/gemini-pro"]);
      expect(result.map((r) => r.value)).toEqual([
        "(inherits parent)",
        "google/gemini-pro",
        "anthropic/claude-3.5-sonnet",
        "openai/gpt-4o",
        "anthropic/claude-3-haiku",
      ]);
    });
  });
});
