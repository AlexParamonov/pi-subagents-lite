/**
 * searchable-select-tab.test.ts — Tab key autocomplete in SearchableSelectDialog.
 *
 * Tests that pressing Tab completes the search query to the first matching
 * suggestion's label, then re-filters the list.
 */

import { describe, it, expect } from "vitest";
import { SearchableSelectDialog, type SuggestionsCallback, type SelectOption } from "../../src/ui/searchable-select.js";
import type { Theme } from "../../src/ui/types.js";

// Minimal theme for constructing the dialog
const theme: Theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function makeDialog(items: SelectOption[], getSuggestions?: SuggestionsCallback) {
  let selectedValue: string | undefined;
  const dialog = new SearchableSelectDialog(
    items,
    null,
    {
      onSelect: (v) => { selectedValue = v; },
      onCancel: () => {},
    },
    theme,
    { getSuggestions },
  );
  return { dialog, getSelectedValue: () => selectedValue };
}

describe("SearchableSelectDialog Tab autocomplete", () => {
  it("completes to first static item on Tab", () => {
    const items = [
      { value: "a", label: "Apple" },
      { value: "b", label: "Banana" },
      { value: "c", label: "Cherry" },
    ];
    const { dialog } = makeDialog(items);

    // Type partial query
    dialog.handleInput("A");

    // Press Tab
    dialog.handleInput("\u0009"); // Tab character

    // Search input should be completed to first match's label
    expect(dialog["searchInput"].getValue()).toBe("Apple");
  });

  it("completes to first suggestion on Tab with suggestions callback", () => {
    const items: SelectOption[] = [];
    const suggestions: SuggestionsCallback = (query) => {
      if (query.startsWith("s")) {
        return [
          { value: "/path/src", label: "./src/", provider: "dir" },
          { value: "/path/src/agents", label: "./src/agents/", provider: "dir" },
        ];
      }
      return [];
    };
    const { dialog } = makeDialog(items, suggestions);

    // Type partial query
    dialog.handleInput("s");

    // Press Tab
    dialog.handleInput("\u0009");

    // Should complete to first suggestion's label
    expect(dialog["searchInput"].getValue()).toBe("./src/");
  });

  it("does nothing on Tab when no filtered items", () => {
    const items = [
      { value: "a", label: "Apple" },
    ];
    const { dialog } = makeDialog(items);

    // Type query with no matches
    dialog.handleInput("z");

    // Press Tab — should not crash, no change
    const beforeValue = dialog["searchInput"].getValue();
    dialog.handleInput("\u0009");
    expect(dialog["searchInput"].getValue()).toBe(beforeValue);
  });

  it("does nothing on Tab when suggestions callback returns empty", () => {
    const items: SelectOption[] = [];
    const suggestions: SuggestionsCallback = () => [];
    const { dialog } = makeDialog(items, suggestions);

    dialog.handleInput("x");
    dialog.handleInput("\u0009");
    // Should remain as typed
    expect(dialog["searchInput"].getValue()).toBe("x");
  });

  it("re-filters list after Tab completion", () => {
    const items = [
      { value: "a", label: "Apple" },
      { value: "b", label: "Banana" },
      { value: "c", label: "Cherry" },
    ];
    const { dialog } = makeDialog(items);

    // Type partial
    dialog.handleInput("A");
    // Tab complete
    dialog.handleInput("\u0009");

    // After completing to "Apple", fuzzy filter should match "Apple"
    // and the first item should still be selected
    const filtered = dialog["filteredItems"];
    expect(filtered.length).toBeGreaterThan(0);
    expect(dialog["selectedIndex"]).toBe(0);
    expect(filtered[0].label).toBe("Apple");
  });

  it("selects completed item on Enter after Tab", () => {
    const items = [
      { value: "a", label: "Apple" },
      { value: "b", label: "Banana" },
      { value: "c", label: "Cherry" },
    ];
    const { dialog, getSelectedValue } = makeDialog(items);

    dialog.handleInput("A");
    dialog.handleInput("\u0009"); // Tab → "Apple"
    dialog.handleInput("\r");     // Enter

    expect(getSelectedValue()).toBe("a");
  });

  it("selects completed suggestion on Enter after Tab with suggestions callback", () => {
    const items: SelectOption[] = [];
    const suggestions: SuggestionsCallback = (query) => {
      if (query.startsWith("s") || query.startsWith("./src")) {
        return [
          { value: "/path/src", label: "./src/", provider: "dir" },
          { value: "/path/src/agents", label: "./src/agents/", provider: "dir" },
        ];
      }
      return [];
    };
    const { dialog, getSelectedValue } = makeDialog(items, suggestions);

    dialog.handleInput("s");
    dialog.handleInput("\u0009"); // Tab → "./src/"
    dialog.handleInput("\r");     // Enter

    expect(getSelectedValue()).toBe("/path/src");
  });

  it("completes to selected item on Tab, not first", () => {
    const items = [
      { value: "a", label: "Apple" },
      { value: "b", label: "Banana" },
      { value: "c", label: "Cherry" },
    ];
    const { dialog } = makeDialog(items);

    // Type partial query to filter
    dialog.handleInput("a");

    // Navigate down to second filtered item
    dialog.handleInput("\u001b[B"); // Down arrow

    // Press Tab — should complete to the *selected* item, not the first
    dialog.handleInput("\u0009");

    // Should complete to "Banana" (the selected item), not "Apple" (the first)
    expect(dialog["searchInput"].getValue()).toBe("Banana");
  });
});
