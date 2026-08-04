/**
 * Tests for createModelSelectSubmenu — 2-step override mode → model selection.
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

  it("returns a function that creates a SelectList with override mode options", () => {
    const factory = createModelSelectSubmenu({
      modelOptions: ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"],
      showClear: false,
      theme: mockTheme,
      onSelect: vi.fn(),
    });
    expect(typeof factory).toBe("function");

    factory("(inherits parent)", vi.fn());
    expect(selectListInstances.length).toBe(1);
    const items = selectListInstances[0].items;
    expect(items).toHaveLength(2);
    expect(items[0].value).toBe("session");
    expect(items[0].label).toContain("session");
    expect(items[1].value).toBe("permanent");
    expect(items[1].label).toContain("permanent");
  });

  it("shows Clear option when showClear is true", () => {
    const factory = createModelSelectSubmenu({
      modelOptions: ["anthropic/claude-sonnet-4-20250514"],
      showClear: true,
      theme: mockTheme,
      onSelect: vi.fn(),
    });
    factory("openai/gpt-4o", vi.fn());
    const items = selectListInstances[0].items;
    expect(items).toHaveLength(3);
    expect(items[2].value).toBe("clear");
  });

  it("calls onSelect with mode='clear' and done when clear is selected", () => {
    const onSelect = vi.fn();
    const done = vi.fn();
    const factory = createModelSelectSubmenu({
      modelOptions: ["anthropic/claude-sonnet-4-20250514"],
      showClear: true,
      theme: mockTheme,
      onSelect,
    });
    factory("openai/gpt-4o", done);
    selectListInstances[0].onSelect!({ value: "clear" });
    expect(onSelect).toHaveBeenCalledWith("clear", null);
    expect(done).toHaveBeenCalledWith("clear");
  });

  it("transitions to model selection when session is selected", () => {
    const onSelect = vi.fn();
    const done = vi.fn();
    const factory = createModelSelectSubmenu({
      modelOptions: ["anthropic/claude-sonnet-4-20250514"],
      showClear: false,
      theme: mockTheme,
      onSelect,
    });
    const component = factory("(inherits parent)", done);
    selectListInstances[0].onSelect!({ value: "session" });
    // onSelect not called yet (model selection step pending)
    expect(onSelect).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    // The delegator now renders the searchable model selector, not the mode list
    expect(component.render(80)).toEqual(["MODEL-SELECTOR-ACTIVE"]);
    // Picking a model in the selector completes the flow with the chosen mode
    searchableSelectInstances[0].callbacks.onSelect("openai/gpt-4o");
    expect(onSelect).toHaveBeenCalledWith("session", "openai/gpt-4o");
    expect(done).toHaveBeenCalledWith("openai/gpt-4o");
  });

  it("transitions to model selection when permanent is selected", () => {
    const onSelect = vi.fn();
    const done = vi.fn();
    const factory = createModelSelectSubmenu({
      modelOptions: ["anthropic/claude-sonnet-4-20250514"],
      showClear: false,
      theme: mockTheme,
      onSelect,
    });
    const component = factory("(inherits parent)", done);
    selectListInstances[0].onSelect!({ value: "permanent" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    // The delegator now renders the searchable model selector, not the mode list
    expect(component.render(80)).toEqual(["MODEL-SELECTOR-ACTIVE"]);
  });

  it("calls done without onSelect on cancel from mode selection", () => {
    const onSelect = vi.fn();
    const done = vi.fn();
    const factory = createModelSelectSubmenu({
      modelOptions: ["anthropic/claude-sonnet-4-20250514"],
      showClear: false,
      theme: mockTheme,
      onSelect,
    });
    factory("(inherits parent)", done);
    selectListInstances[0].onCancel!();
    expect(onSelect).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith();
  });
});
