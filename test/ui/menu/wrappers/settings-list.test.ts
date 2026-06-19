/**
 * settings-list.test.ts — Tests for the SettingsListWrapper frame component.
 *
 * Runs the real wrapper against minimal fake list components (no pi-tui import),
 * exercising the contract the wrapper must uphold now that the Back button is gone.
 */

import { describe, it, expect, vi } from "vitest";
import { SettingsListWrapper } from "../../../../src/ui/menu/wrappers/settings-list.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function makeSettingsList(items: any[]) {
  return {
    items,
    onChange: vi.fn(),
    onCancel: vi.fn(),
    selectedIndex: 0,
    render: () => [] as string[],
    handleInput: () => {},
    invalidate: () => {},
  };
}

function makeSelectList(items: any[]) {
  return {
    items,
    onSelect: undefined as ((item: any) => void) | undefined,
    onCancel: undefined as (() => void) | undefined,
    selectedIndex: 0,
    render: () => [] as string[],
    handleInput: () => {},
  };
}

describe("SettingsListWrapper — Back button removed", () => {
  it("does not append __back__ or __sep__ to SettingsList items", () => {
    const list = makeSettingsList([{ id: "a", label: "A", currentValue: "" }]);
    new SettingsListWrapper(list, { title: "T", theme, onCancel: () => {} });
    expect(list.items.map((i) => i.id)).toEqual(["a"]);
  });

  it("does not append __back__ or __sep__ to SelectList items", () => {
    const list = makeSelectList([{ value: "a", label: "A" }]);
    new SettingsListWrapper(list, { title: "T", theme, onCancel: () => {} });
    expect(list.items.map((i) => i.value)).toEqual(["a"]);
  });

  it("does not wrap SelectList.onSelect (passes through to caller)", () => {
    const list = makeSelectList([{ value: "a", label: "A" }]);
    const onSelect = vi.fn();
    list.onSelect = onSelect;
    new SettingsListWrapper(list, { title: "T", theme, onCancel: () => {} });
    expect(list.onSelect).toBe(onSelect);
  });
});

describe("SettingsListWrapper — close menu via keyboard", () => {
  it("wires SelectList.onCancel so Escape/back-arrow/Ctrl-C close the menu", () => {
    const list = makeSelectList([{ value: "a", label: "A" }]);
    const closeMenu = vi.fn();
    new SettingsListWrapper(list, { title: "T", theme, onCancel: closeMenu });
    expect(typeof list.onCancel).toBe("function");
    list.onCancel!();
    expect(closeMenu).toHaveBeenCalled();
  });

  it("preserves SettingsList.onCancel when provided", () => {
    const onCancel = vi.fn();
    const list = makeSettingsList([{ id: "a", label: "A", currentValue: "" }]);
    list.onCancel = onCancel;
    new SettingsListWrapper(list, { title: "T", theme, onCancel: () => {} });
    expect(list.onCancel).toBe(onCancel);
  });
});

describe("SettingsListWrapper — __sep__ navigation", () => {
  it("selectedIndex never lands on a __sep__ item when moving down", () => {
    const list = makeSettingsList([
      { id: "a", label: "A", currentValue: "" },
      { id: "__sep__", label: " ", currentValue: "" },
      { id: "b", label: "B", currentValue: "" },
    ]);
    new SettingsListWrapper(list, { title: "T", theme, onCancel: () => {} });
    expect(list.selectedIndex).toBe(0);
    // down past the separator
    (list as any).selectedIndex = 1;
    expect((list.items as any[])[list.selectedIndex].id).toBe("b");
  });

  it("selectedIndex never lands on a __sep__ item when moving up", () => {
    const list = makeSettingsList([
      { id: "a", label: "A", currentValue: "" },
      { id: "__sep__", label: " ", currentValue: "" },
      { id: "b", label: "B", currentValue: "" },
    ]);
    new SettingsListWrapper(list, { title: "T", theme, onCancel: () => {} });
    (list as any).selectedIndex = 2;
    expect((list.items as any[])[list.selectedIndex].id).toBe("b");
    // up past the separator
    (list as any).selectedIndex = 1;
    expect((list.items as any[])[list.selectedIndex].id).toBe("a");
  });

  it("falls back to the opposite direction when a trailing separator is the target", () => {
    const list = makeSettingsList([
      { id: "a", label: "A", currentValue: "" },
      { id: "b", label: "B", currentValue: "" },
      { id: "__sep__", label: " ", currentValue: "" },
    ]);
    new SettingsListWrapper(list, { title: "T", theme, onCancel: () => {} });
    // moving down past the end lands on the trailing sep, which clamp +
    // backward fallback should resolve back to the last real item
    (list as any).selectedIndex = 5;
    expect((list.items as any[])[list.selectedIndex].id).toBe("b");
  });
});

describe("SettingsListWrapper — onRebuild sets items directly", () => {
  it("rebuild replaces items without appending wrapper (__sep__/__back__) items", () => {
    const list = makeSettingsList([{ id: "a", label: "A", currentValue: "" }]);
    let rebuild: ((items: any[]) => void) | undefined;
    new SettingsListWrapper(list, {
      title: "T",
      theme,
      onCancel: () => {},
      onRebuild: (r) => { rebuild = r; },
    });
    expect(rebuild).toBeDefined();
    rebuild!([{ id: "x", label: "X", currentValue: "x" }]);
    expect(list.items.map((i) => i.id)).toEqual(["x"]);
    expect(list.filteredItems).toEqual(list.items);
    expect(list.selectedIndex).toBe(0);
  });
});

describe("SettingsListWrapper — render frame", () => {
  it("renders the list content between top/bottom separators with a header", () => {
    const list = {
      items: [{ id: "a", label: "A", currentValue: "" }] as any[],
      selectedIndex: 0,
      render: () => ["  → A     value"],
      handleInput: () => {},
      invalidate: () => {},
    };
    const wrapper = new SettingsListWrapper(list, { title: "My Title", theme });
    const lines = wrapper.render(40);
    // top separator, blank, header, blank, list content, blank, bottom separator
    expect(lines[0]).toBe("─".repeat(40));
    expect(lines[2]).toBe("  My Title");
    expect(lines[4]).toBe("  → A     value");
    expect(lines[lines.length - 1]).toBe("─".repeat(40));
  });
});
