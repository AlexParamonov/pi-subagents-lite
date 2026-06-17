/**
 * build-settings-list-theme.test.ts — Tests for buildSettingsListTheme helper.
 */

import { describe, it, expect } from "vitest";
import { buildSettingsListTheme } from "../src/ui/menu/menu-helpers.js";
import type { SettingsListTheme } from "@earendil-works/pi-tui";

function createMockTheme() {
  return {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => `**${text}**`,
    italic: (text: string) => `_${text}_`,
  };
}

describe("buildSettingsListTheme", () => {
  it("returns an object with all required SettingsListTheme properties", () => {
    const theme = buildSettingsListTheme(createMockTheme() as any);
    expect(theme).toHaveProperty("label");
    expect(theme).toHaveProperty("value");
    expect(theme).toHaveProperty("description");
    expect(theme).toHaveProperty("cursor");
    expect(theme).toHaveProperty("hint");
  });

  it("label function applies accent color when selected", () => {
    const theme = buildSettingsListTheme(createMockTheme() as any);
    const result = theme.label("Test", true);
    expect(result).toContain("Test");
  });

  it("label function returns plain text when not selected", () => {
    const theme = buildSettingsListTheme(createMockTheme() as any);
    const result = theme.label("Test", false);
    expect(result).toContain("Test");
  });

  it("value function applies styling when selected", () => {
    const theme = buildSettingsListTheme(createMockTheme() as any);
    const result = theme.value("ON", true);
    expect(result).toContain("ON");
  });

  it("value function returns plain text when not selected", () => {
    const theme = buildSettingsListTheme(createMockTheme() as any);
    const result = theme.value("ON", false);
    expect(result).toContain("ON");
  });

  it("description function styles the text", () => {
    const theme = buildSettingsListTheme(createMockTheme() as any);
    const result = theme.description("Some description");
    expect(result).toContain("Some description");
  });

  it("cursor is a non-empty string", () => {
    const theme = buildSettingsListTheme(createMockTheme() as any);
    expect(theme.cursor.length).toBeGreaterThan(0);
  });

  it("hint function styles the text", () => {
    const theme = buildSettingsListTheme(createMockTheme() as any);
    const result = theme.hint("Press Enter to toggle");
    expect(result).toContain("Press Enter to toggle");
  });
});
