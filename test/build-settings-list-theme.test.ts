/**
 * build-settings-list-theme.test.ts — Tests for buildSettingsListTheme helper.
 */

import { describe, it, expect } from "vitest";
import { buildSettingsListTheme } from "../src/ui/menu/helpers.js";
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

  it("label applies accent when selected", () => {
    const theme = buildSettingsListTheme(createMockTheme() as any);
    expect(theme.label("Test", true)).toBe("<accent>Test</accent>");
  });

  it("label returns plain text when not selected", () => {
    const theme = buildSettingsListTheme(createMockTheme() as any);
    expect(theme.label("Test", false)).toBe("Test");
  });

  it("value uses accent when selected", () => {
    const theme = buildSettingsListTheme(createMockTheme() as any);
    expect(theme.value("ON", true)).toBe("<accent>ON</accent>");
  });

  it("value uses muted when not selected", () => {
    const theme = buildSettingsListTheme(createMockTheme() as any);
    expect(theme.value("ON", false)).toBe("<muted>ON</muted>");
  });

  it("description uses muted", () => {
    const theme = buildSettingsListTheme(createMockTheme() as any);
    expect(theme.description("Some description")).toBe("<muted>Some description</muted>");
  });

  it("cursor uses accent", () => {
    const theme = buildSettingsListTheme(createMockTheme() as any);
    // Cursor includes trailing space to match non-selected prefix width
    expect(theme.cursor).toBe("<accent>→ </accent>");
  });

  it("hint uses dim", () => {
    const theme = buildSettingsListTheme(createMockTheme() as any);
    expect(theme.hint("Press Enter to toggle")).toBe("<dim>Press Enter to toggle</dim>");
  });
});
