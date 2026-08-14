/**
 * Tests for createModelSelectSubmenu — target level → model selection,
 * with a nested per-level clear picker (ADR-0008).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

let selectListInstances: Array<{
  items: any[];
  onSelect?: (item: any) => void;
  onCancel?: () => void;
  render: (w: number) => string[];
  handleInput: (d: string) => void;
}> = [];

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList {
    constructor() {}
  },
  SelectList: class MockSelectList {
    items: any[];
    onSelect?: (item: any) => void;
    onCancel?: () => void;
    constructor(items: any[]) {
      this.items = items;
      selectListInstances.push(this as any);
    }
    render() {
      return [];
    }
    handleInput() {}
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
}));

let searchableSelectInstances: Array<{ items: any[]; callbacks: any }> = [];

vi.mock("../../../../src/ui/searchable-select.js", () => ({
  SearchableSelectDialog: class MockSearchableSelectDialog {
    items: any[];
    callbacks: any;
    constructor(items: any[], _currentValue: any, callbacks: any, _theme: any) {
      this.items = items;
      this.callbacks = callbacks;
      searchableSelectInstances.push(this as any);
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
    selectListInstances = [];
    searchableSelectInstances = [];
    vi.clearAllMocks();
  });

  const mockTheme = {
    fg: (_c: string, t: string) => t,
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

  it("returns a function that creates a SelectList with target options", () => {
    const factory = createModelSelectSubmenu({ ...baseOptions });
    expect(typeof factory).toBe("function");

    factory("(inherits parent)", vi.fn());
    expect(selectListInstances.length).toBe(1);
    const items = selectListInstances[0].items;
    expect(items).toHaveLength(2);
    expect(items[0].value).toBe("session");
    expect(items[0].label).toContain("session");
    expect(items[1].value).toBe("global");
    expect(items[1].label).toContain("global");
  });

  it("offers the project target when the project layer is available", () => {
    const factory = createModelSelectSubmenu({ ...baseOptions, projectOffered: true });
    factory("(inherits parent)", vi.fn());
    const items = selectListInstances[0].items;
    expect(items.map((i: any) => i.value)).toEqual(["session", "global", "project"]);
  });

  it("shows Clear option when showClear is true", () => {
    const factory = createModelSelectSubmenu({ ...baseOptions, showClear: true });
    factory("openai/gpt-4o", vi.fn());
    const items = selectListInstances[0].items;
    expect(items).toHaveLength(3);
    expect(items[2].value).toBe("clear");
  });

  it("nested clear picker calls onClear with the picked target and done", () => {
    const onClear = vi.fn();
    const done = vi.fn();
    const factory = createModelSelectSubmenu({ ...baseOptions, showClear: true, onClear });
    factory("openai/gpt-4o", done);
    selectListInstances[0].onSelect!({ value: "clear" });

    // The nested target picker is a second SelectList with "all levels".
    const targetList = selectListInstances[1];
    expect(targetList.items.map((i: any) => i.value)).toEqual(["session", "global", "all"]);
    targetList.onSelect!({ value: "global" });

    expect(onClear).toHaveBeenCalledWith("global", expect.any(Function));
    expect(done).toHaveBeenCalledWith("global");
  });

  it("transitions to model selection when session is selected", () => {
    const onSet = vi.fn();
    const done = vi.fn();
    const factory = createModelSelectSubmenu({ ...baseOptions, onSet });
    const component = factory("(inherits parent)", done);
    selectListInstances[0].onSelect!({ value: "session" });
    // onSet not called yet (model selection step pending)
    expect(onSet).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    // The delegator now renders the searchable model selector, not the mode list
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
    selectListInstances[0].onSelect!({ value: "global" });
    expect(onSet).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    // The delegator now renders the searchable model selector, not the mode list
    expect(component.render(80)).toEqual(["MODEL-SELECTOR-ACTIVE"]);
  });

  it("calls done without onSet on cancel from mode selection", () => {
    const onSet = vi.fn();
    const done = vi.fn();
    const factory = createModelSelectSubmenu({ ...baseOptions, onSet });
    factory("(inherits parent)", done);
    selectListInstances[0].onCancel!();
    expect(onSet).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith();
  });
});
