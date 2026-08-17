/**
 * Tests for createModelSelectSubmenu — target level → model selection,
 * with a nested per-level clear picker (ADR-0008).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Component, SettingItem, SettingsListTheme } from "@earendil-works/pi-tui";
import type { SelectOption } from "../../../../src/ui/searchable-select.js";
import type { Theme } from "../../../../src/ui/types.js";

let settingsListCalls: Array<{
  items: SettingItem[];
  onChange: (id: string, newValue: string) => void;
  onCancel: () => void;
  submenuComponent: Component | null;
  activate: (id: string) => void;
}> = [];

vi.mock("@earendil-works/pi-tui", async () => {
  const { activatePickerRow } = await import("../../../menu-picker-helpers.js");
  return {
    SettingsList: class MockSettingsList {
      items: SettingItem[];
      onChange: (id: string, newValue: string) => void;
      onCancel: () => void;
      submenuComponent: Component | null = null;
      constructor(
        items: SettingItem[],
        _max: number,
        _theme: SettingsListTheme,
        onChange: (id: string, newValue: string) => void,
        onCancel: () => void,
      ) {
        this.items = items;
        this.onChange = onChange;
        this.onCancel = onCancel;
        settingsListCalls.push(this);
      }
      render() {
        return this.submenuComponent ? this.submenuComponent.render(80) : [];
      }
      handleInput() {}
      activate(id: string) {
        activatePickerRow(this, id);
      }
    },
    Input: class MockInput {
      value = "";
      onSubmit?: (v: string) => void;
      onEscape?: () => void;
      setValue(v: string) {
        this.value = v;
      }
      getValue() {
        return this.value;
      }
    },
    Container: class MockContainer {
      addChild() {}
      clear() {}
      render() {
        return [];
      }
      invalidate() {}
    },
    Spacer: class MockSpacer {
      constructor() {}
    },
    Text: class MockText {
      constructor() {}
    },
    fuzzyFilter: vi.fn((_items, _query, _accessor) => []),
    getKeybindings: vi.fn(() => ({ matches: () => false })),
  };
});

let searchableSelectInstances: Array<{ items: SelectOption[]; callbacks: SelectDialogCallbacks }> = [];

// Mirrors the (non-exported) SelectDialogCallbacks in src/ui/searchable-select.ts.
interface SelectDialogCallbacks {
  onSelect: (value: string) => void;
  onCancel: () => void;
}

vi.mock("../../../../src/ui/searchable-select.js", () => ({
  SearchableSelectDialog: class MockSearchableSelectDialog {
    items: SelectOption[];
    callbacks: SelectDialogCallbacks;
    constructor(items: SelectOption[], _currentValue: string | null, callbacks: SelectDialogCallbacks, _theme: Theme) {
      this.items = items;
      this.callbacks = callbacks;
      searchableSelectInstances.push(this);
    }
    // Distinct sentinel so tests can observe which component the delegator renders
    render() {
      return ["MODEL-SELECTOR-ACTIVE"];
    }
    handleInput() {}
    invalidate() {}
  },
}));

vi.mock("../../../../src/utils.js", () => ({
  parseModelKey: vi.fn((key: string) => {
    const parts = key.split("/");
    if (parts.length === 2) return { provider: parts[0], modelId: parts[1] };
    return null;
  }),
}));

import { createModelSelectSubmenu } from "../../../../src/ui/menu/submenus/model-select.js";

describe("createModelSelectSubmenu", () => {
  beforeEach(() => {
    settingsListCalls = [];
    searchableSelectInstances = [];
    vi.clearAllMocks();
  });

  const mockTheme: Theme = {
    fg: (_c: string, t: string) => t,
    bg: (_c: string, t: string) => t,
    bold: (t: string) => t,
    italic: (t: string) => t,
  };

  const baseOptions = {
    modelOptions: ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"],
    showClear: false,
    projectOffered: false,
    theme: mockTheme,
    onSet: vi.fn(),
    onClear: vi.fn(),
  };

  it("returns a function that creates a SettingsList picker with target rows", () => {
    const factory = createModelSelectSubmenu({ ...baseOptions });
    expect(typeof factory).toBe("function");

    factory("(inherits parent)", vi.fn());
    expect(settingsListCalls.length).toBe(1);
    const items = settingsListCalls[0].items;
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe("session");
    expect(items[0].label).toBe("Session");
    expect(items[1].id).toBe("global");
    expect(items[1].label).toBe("Global");
  });

  it("describes each level's persistence", () => {
    const factory = createModelSelectSubmenu({ ...baseOptions, projectOffered: true });
    factory("(inherits parent)", vi.fn());
    const items = settingsListCalls[0].items;
    expect(items.map((i) => i.description)).toEqual([
      "Not saved",
      "Saves to the global config file",
      "Saves to the project config file",
    ]);
  });

  it("offers the project target when the project layer is available", () => {
    const factory = createModelSelectSubmenu({ ...baseOptions, projectOffered: true });
    factory("(inherits parent)", vi.fn());
    const items = settingsListCalls[0].items;
    expect(items.map((i) => i.id)).toEqual(["session", "global", "project"]);
  });

  it("shows Clear option when showClear is true", () => {
    const factory = createModelSelectSubmenu({ ...baseOptions, showClear: true });
    factory("openai/gpt-4o", vi.fn());
    const items = settingsListCalls[0].items;
    expect(items).toHaveLength(3);
    expect(items[2].id).toBe("clear");
  });

  it("nested clear picker calls onClear with the picked target", () => {
    const onClear = vi.fn();
    const done = vi.fn();
    const factory = createModelSelectSubmenu({ ...baseOptions, showClear: true, onClear });
    factory("openai/gpt-4o", done);
    settingsListCalls[0].activate("clear");

    // The nested target picker is a second SettingsList with "all levels".
    const targetList = settingsListCalls[1];
    expect(targetList.items.map((i) => i.id)).toEqual(["session", "global", "all"]);
    targetList.activate("global");

    expect(onClear).toHaveBeenCalledWith("global");
    expect(done).toHaveBeenCalledWith("global");
  });

  it("with availableLevels, the nested clear picker offers only the listed levels", () => {
    const factory = createModelSelectSubmenu({
      ...baseOptions,
      showClear: true,
      projectOffered: true,
      availableLevels: { session: false, global: false, project: true },
    });
    factory("openai/gpt-4o", vi.fn());
    // The set entries are not filtered; only the nested clear picker is.
    expect(settingsListCalls[0].items.map((i) => i.id)).toEqual(["session", "global", "project", "clear"]);
    settingsListCalls[0].activate("clear");
    const targetList = settingsListCalls[1];
    // One level → no "All levels".
    expect(targetList.items.map((i) => i.id)).toEqual(["project"]);
  });

  it("with availableLevels, offers 'All levels' only when at least two levels have the setting", () => {
    const factory = createModelSelectSubmenu({
      ...baseOptions,
      showClear: true,
      projectOffered: true,
      availableLevels: { session: true, global: true, project: false },
    });
    factory("openai/gpt-4o", vi.fn());
    settingsListCalls[0].activate("clear");
    const targetList = settingsListCalls[1];
    expect(targetList.items.map((i) => i.id)).toEqual(["session", "global", "all"]);
  });

  it("describes the clear picker levels as removals", () => {
    const factory = createModelSelectSubmenu({ ...baseOptions, showClear: true, projectOffered: true });
    factory("openai/gpt-4o", vi.fn());
    // The mode list keeps the set wording; the nested clear picker switches
    // to "Removes from...".
    expect(settingsListCalls[0].items.map((i) => i.description)).toEqual([
      "Not saved",
      "Saves to the global config file",
      "Saves to the project config file",
      undefined,
    ]);
    settingsListCalls[0].activate("clear");
    const targetList = settingsListCalls[1];
    expect(targetList.items.map((i) => i.description)).toEqual([
      "Removes from the session",
      "Removes from the global config file",
      "Removes from the project config file",
      undefined,
    ]);
  });

  it("without availableLevels, the nested clear picker keeps the structural level list", () => {
    const factory = createModelSelectSubmenu({ ...baseOptions, showClear: true, projectOffered: true });
    factory("openai/gpt-4o", vi.fn());
    settingsListCalls[0].activate("clear");
    const targetList = settingsListCalls[1];
    expect(targetList.items.map((i) => i.id)).toEqual(["session", "global", "project", "all"]);
  });

  it("transitions to model selection when session is selected", () => {
    const onSet = vi.fn();
    const done = vi.fn();
    const factory = createModelSelectSubmenu({ ...baseOptions, onSet });
    const component = factory("(inherits parent)", done);
    settingsListCalls[0].activate("session");
    // onSet not called yet (model selection step pending)
    expect(onSet).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    // The picker now renders the searchable model selector as its submenu
    expect(component.render(80)).toEqual(["MODEL-SELECTOR-ACTIVE"]);
    // Picking a model in the selector completes the flow with the chosen target
    searchableSelectInstances[0].callbacks.onSelect("openai/gpt-4o");
    expect(onSet).toHaveBeenCalledWith("session", "openai/gpt-4o");
    expect(done).toHaveBeenCalledWith("openai/gpt-4o");
  });

  it("transitions to model selection when global is selected", () => {
    const onSet = vi.fn();
    const done = vi.fn();
    const factory = createModelSelectSubmenu({ ...baseOptions, onSet });
    const component = factory("(inherits parent)", done);
    settingsListCalls[0].activate("global");
    expect(onSet).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    // The picker now renders the searchable model selector as its submenu
    expect(component.render(80)).toEqual(["MODEL-SELECTOR-ACTIVE"]);
  });

  it("calls done without onSet on cancel from mode selection", () => {
    const onSet = vi.fn();
    const done = vi.fn();
    const factory = createModelSelectSubmenu({ ...baseOptions, onSet });
    factory("(inherits parent)", done);
    settingsListCalls[0].onCancel();
    expect(onSet).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith();
  });
});
