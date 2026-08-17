/**
 * settings-list.test.ts — Tests for the SettingsListWrapper frame component.
 *
 * Runs the real wrapper against minimal fake list components, exercising the
 * contract the wrapper must uphold now that the Back button is gone.
 */

import { describe, it, expect, vi, type Mock } from "vitest";
import { SelectList, type Component, type SelectItem, type SettingItem } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { SettingsListWrapper } from "../../../../src/ui/menu/wrappers/settings-list.js";
import { buildSelectListTheme, createDelegatingComponent } from "../../../../src/ui/menu/helpers.js";
import { SearchableSelectDialog } from "../../../../src/ui/searchable-select.js";
import { selectListView } from "../../../pi-boundaries.ts";
import type { Theme } from "../../../../src/ui/types.js";

const theme: Theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

/** The fake SettingsList surface the wrapper reads and rebuild writes. */
interface FakeSettingsList {
  items: SettingItem[];
  filteredItems?: SettingItem[];
  onChange: Mock<(id: string, newValue: string) => void>;
  onCancel: Mock<() => void>;
  selectedIndex: number;
  submenuComponent: Component | null;
  render: () => string[];
  invalidate: () => void;
  handleInput: (data: string) => void;
}
function makeSettingsList(items: SettingItem[]): FakeSettingsList {
  const list: FakeSettingsList = {
    items,
    onChange: vi.fn(),
    onCancel: vi.fn(),
    selectedIndex: 0,
    submenuComponent: null,
    render: () => [],
    invalidate: () => {},
    handleInput: () => {},
  };
  // Mirror pi-tui's SettingsList: with a submenu active, input goes to it.
  list.handleInput = (data: string) => {
    if (list.submenuComponent) list.submenuComponent.handleInput?.(data);
  };
  return list;
}
function makeSelectList(items: SelectItem[]) {
  return {
    items,
    onSelect: undefined as ((item: SelectItem) => void) | undefined,
    onCancel: undefined as (() => void) | undefined,
    selectedIndex: 0,
    render: () => [] as string[],
    invalidate: () => {},
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
    list.selectedIndex = 1;
    expect(list.items[list.selectedIndex].id).toBe("b");
  });

  it("selectedIndex never lands on a __sep__ item when moving up", () => {
    const list = makeSettingsList([
      { id: "a", label: "A", currentValue: "" },
      { id: "__sep__", label: " ", currentValue: "" },
      { id: "b", label: "B", currentValue: "" },
    ]);
    new SettingsListWrapper(list, { title: "T", theme, onCancel: () => {} });
    list.selectedIndex = 2;
    expect(list.items[list.selectedIndex].id).toBe("b");
    // up past the separator
    list.selectedIndex = 1;
    expect(list.items[list.selectedIndex].id).toBe("a");
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
    list.selectedIndex = 5;
    expect(list.items[list.selectedIndex].id).toBe("b");
  });
});

describe("SettingsListWrapper — onRebuild sets items directly", () => {
  it("rebuild replaces items without appending wrapper (__sep__/__back__) items", () => {
    const list = makeSettingsList([{ id: "a", label: "A", currentValue: "" }]);
    let rebuild: ((items: SettingItem[]) => void) | undefined;
    new SettingsListWrapper(list, {
      title: "T",
      theme,
      onCancel: () => {},
      onRebuild: (r) => {
        rebuild = r;
      },
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
      items: [{ id: "a", label: "A", currentValue: "" }],
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
describe("SettingsListWrapper — j/k navigation", () => {
  it("keeps converting j/k to arrows in the main list (no submenu)", () => {
    const list = makeSettingsList([{ id: "a", label: "A", currentValue: "" }]);
    list.handleInput = vi.fn();
    const wrapper = new SettingsListWrapper(list, { title: "T", theme, onCancel: () => {} });
    wrapper.handleInput("j");
    expect(list.handleInput).toHaveBeenCalledWith("\x1b[B");
    wrapper.handleInput("k");
    expect(list.handleInput).toHaveBeenCalledWith("\x1b[A");
  });

  it("converts j/k to arrows in a delegator-wrapped SelectList submenu", () => {
    const selectList = makeSelectList([
      { value: "session", label: "Session" },
      { value: "global", label: "Global" },
    ]);
    selectList.handleInput = vi.fn();
    const settings = makeSettingsList([{ id: "x", label: "X", currentValue: "" }]);
    settings.submenuComponent = createDelegatingComponent(selectList);
    const wrapper = new SettingsListWrapper(settings, { title: "T", theme, onCancel: () => {} });
    wrapper.handleInput("j");
    expect(selectList.handleInput).toHaveBeenCalledWith("\x1b[B");
    wrapper.handleInput("k");
    expect(selectList.handleInput).toHaveBeenCalledWith("\x1b[A");
  });

  it("resolves nested delegators to the leaf SelectList", () => {
    const selectList = makeSelectList([{ value: "a", label: "A" }]);
    selectList.handleInput = vi.fn();
    const inner = createDelegatingComponent(selectList);
    const outer = createDelegatingComponent(inner);
    const settings = makeSettingsList([{ id: "x", label: "X", currentValue: "" }]);
    settings.submenuComponent = outer;
    const wrapper = new SettingsListWrapper(settings, { title: "T", theme, onCancel: () => {} });
    wrapper.handleInput("j");
    expect(selectList.handleInput).toHaveBeenCalledWith("\x1b[B");
  });

  it("passes j/k through as letters for an Input leaf (getValue)", () => {
    const input = {
      focused: false,
      getValue: () => "",
      render: () => [] as string[],
      invalidate: () => {},
      handleInput: vi.fn(),
    };
    const settings = makeSettingsList([{ id: "x", label: "X", currentValue: "" }]);
    settings.submenuComponent = createDelegatingComponent(input);
    const wrapper = new SettingsListWrapper(settings, { title: "T", theme, onCancel: () => {} });
    wrapper.handleInput("j");
    expect(input.handleInput).toHaveBeenCalledWith("j");
    wrapper.handleInput("k");
    expect(input.handleInput).toHaveBeenCalledWith("k");
  });

  it("passes j/k through as letters for a SearchableSelectDialog leaf (searchInput)", () => {
    const dialog = {
      focused: false,
      searchInput: {},
      render: () => [] as string[],
      invalidate: () => {},
      handleInput: vi.fn(),
    };
    const settings = makeSettingsList([{ id: "x", label: "X", currentValue: "" }]);
    settings.submenuComponent = createDelegatingComponent(dialog);
    const wrapper = new SettingsListWrapper(settings, { title: "T", theme, onCancel: () => {} });
    wrapper.handleInput("k");
    expect(dialog.handleInput).toHaveBeenCalledWith("k");
  });

  it("converts j/k to arrows for a raw SelectList submenu (confirm dialog)", () => {
    const selectList = makeSelectList([
      { value: "Yes", label: "Yes" },
      { value: "No", label: "No" },
    ]);
    selectList.handleInput = vi.fn();
    const settings = makeSettingsList([{ id: "x", label: "X", currentValue: "" }]);
    settings.submenuComponent = selectList;
    const wrapper = new SettingsListWrapper(settings, { title: "T", theme, onCancel: () => {} });
    wrapper.handleInput("j");
    expect(selectList.handleInput).toHaveBeenCalledWith("\x1b[B");
  });

  it("sees through a SettingsList picker (focused + getActive) to a text-input leaf", () => {
    // The level pickers are SettingsLists with a chained step as their own
    // submenuComponent; getActive exposes it so j/k stay letters.
    const input = {
      focused: false,
      getValue: () => "",
      render: () => [] as string[],
      invalidate: () => {},
      handleInput: vi.fn(),
    };
    const picker = {
      focused: true,
      submenuComponent: input,
      getActive: () => input,
      handleInput: (d: string) => input.handleInput(d),
      render: () => [] as string[],
      invalidate: () => {},
    };
    const settings = makeSettingsList([{ id: "x", label: "X", currentValue: "" }]);
    settings.submenuComponent = picker;
    const wrapper = new SettingsListWrapper(settings, { title: "T", theme, onCancel: () => {} });
    wrapper.handleInput("j");
    expect(input.handleInput).toHaveBeenCalledWith("j");
  });
});

describe("SettingsListWrapper — j/k drive a real SelectList submenu", () => {
  it("moves selection with wrap-around through a delegator", () => {
    const list = new SelectList(
      [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
        { value: "c", label: "C" },
      ],
      5,
      buildSelectListTheme(theme),
    );
    const settings = makeSettingsList([{ id: "x", label: "X", currentValue: "" }]);
    settings.submenuComponent = createDelegatingComponent(list);
    const wrapper = new SettingsListWrapper(settings, { title: "T", theme, onCancel: () => {} });
    expect(selectListView(list).selectedIndex).toBe(0);
    wrapper.handleInput("j");
    expect(selectListView(list).selectedIndex).toBe(1);
    wrapper.handleInput("j");
    expect(selectListView(list).selectedIndex).toBe(2);
    wrapper.handleInput("j"); // wraps to the top
    expect(selectListView(list).selectedIndex).toBe(0);
    wrapper.handleInput("k"); // wraps to the bottom
    expect(selectListView(list).selectedIndex).toBe(2);
  });

  it("moves a raw SelectList submenu (confirm dialog) with wrap-around", () => {
    const list = new SelectList(
      [
        { value: "Yes", label: "Yes" },
        { value: "No", label: "No" },
      ],
      5,
      buildSelectListTheme(theme),
    );
    const settings = makeSettingsList([{ id: "x", label: "X", currentValue: "" }]);
    settings.submenuComponent = list;
    const wrapper = new SettingsListWrapper(settings, { title: "T", theme, onCancel: () => {} });
    expect(selectListView(list).selectedIndex).toBe(0);
    wrapper.handleInput("j");
    expect(selectListView(list).selectedIndex).toBe(1);
    wrapper.handleInput("k");
    expect(selectListView(list).selectedIndex).toBe(0);
    wrapper.handleInput("k"); // wraps to the bottom
    expect(selectListView(list).selectedIndex).toBe(1);
  });

  it("keeps j/k as letters in a real SearchableSelectDialog submenu", () => {
    // The dialog renders against pi's global theme; initialize it like the app does.
    initTheme("dark", false);
    const dialog = new SearchableSelectDialog(
      [
        { value: "m/a", label: "alpha" },
        { value: "m/b", label: "beta" },
      ],
      null,
      { onSelect: () => {}, onCancel: () => {} },
      theme,
    );
    const settings = makeSettingsList([{ id: "x", label: "X", currentValue: "" }]);
    settings.submenuComponent = createDelegatingComponent(dialog);
    const wrapper = new SettingsListWrapper(settings, { title: "T", theme, onCancel: () => {} });
    // 'j'/'k' must reach the search input and accumulate in the query, not
    // move the list: after "k" + "a" the query is "ka", matching nothing.
    // If "k" were converted to an arrow, the query would be "a" → [alpha].
    wrapper.handleInput("k");
    wrapper.handleInput("a");
    const text = dialog.render(40).join("\n");
    expect(text).toContain("No matching items");
  });
});
