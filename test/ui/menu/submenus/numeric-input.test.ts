/**
 * Tests for createNumericSubmenu — shared numeric input submenu Component.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCtx } from "../../../menu-test-helpers.js";

let inputInstances: Array<{
  value: string;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  setValue: (v: string) => void;
  getValue: () => string;
}> = [];

// Mock only the heavy deps of helpers.js (searchable-select pulls in pi-tui
// components the partial pi-tui mock doesn't provide). validateNumeric itself
// is imported for real — helpers.test.ts pins the same function.
vi.mock("../../../../src/ui/searchable-select.js", () => ({
  SearchableSelectDialog: class MockSearchableSelectDialog {},
}));

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList {
    constructor() {}
  },
  Input: class MockInput {
    value = "";
    onSubmit?: (value: string) => void;
    onEscape?: () => void;
    setValue(v: string) {
      this.value = v;
    }
    getValue() {
      return this.value;
    }
    constructor() {
      inputInstances.push(this);
    }
  },
}));

import { createNumericSubmenu } from "../../../../src/ui/menu/submenus/numeric-input.js";

describe("createNumericSubmenu", () => {
  beforeEach(() => {
    inputInstances = [];
    vi.clearAllMocks();
  });

  it("returns a function that creates an Input component", () => {
    const factory = createNumericSubmenu(createMockCtx(), vi.fn<(parsed: number) => void>());
    expect(typeof factory).toBe("function");

    factory("5", vi.fn());
    expect(inputInstances.length).toBe(1);
    expect(inputInstances[0].value).toBe("5");
  });

  it("calls onValid and done with parsed value on valid submit", () => {
    const onValid = vi.fn();
    const done = vi.fn();
    createNumericSubmenu(createMockCtx(), onValid)("5", done);
    inputInstances[0].onSubmit!("10");
    expect(onValid).toHaveBeenCalledWith(10);
    expect(done).toHaveBeenCalledWith("10");
  });

  it("calls onError and does NOT call done on invalid submit", () => {
    const ctx = createMockCtx();
    const onValid = vi.fn();
    const done = vi.fn();
    createNumericSubmenu(ctx, onValid)("5", done);
    inputInstances[0].onSubmit!("0");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(onValid).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it("rejects non-numeric input", () => {
    const ctx = createMockCtx();
    const done = vi.fn();
    createNumericSubmenu(ctx, { min: 0 })("5", done);
    inputInstances[0].onSubmit!("abc");
    expect(ctx.ui.notify).toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it("accepts value at exact minimum", () => {
    const onValid = vi.fn();
    const done = vi.fn();
    createNumericSubmenu(createMockCtx(), { min: 5 }, onValid)("5", done);
    inputInstances[0].onSubmit!("5");
    expect(onValid).toHaveBeenCalledWith(5);
    expect(done).toHaveBeenCalledWith("5");
  });

  it("calls done() without argument on escape", () => {
    const done = vi.fn();
    createNumericSubmenu(createMockCtx())("5", done);
    inputInstances[0].onEscape!();
    expect(done).toHaveBeenCalledWith();
  });

  it("calls onEmpty and done('(not set)') on empty input", () => {
    const onEmpty = vi.fn();
    const done = vi.fn();
    createNumericSubmenu(createMockCtx(), {}, vi.fn(), onEmpty)("5", done);
    inputInstances[0].onSubmit!("");
    expect(onEmpty).toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith("(not set)");
  });

  it("calls onEmpty and done('(not set)') when input is 'unlimited'", () => {
    const onEmpty = vi.fn();
    const done = vi.fn();
    createNumericSubmenu(createMockCtx(), {}, vi.fn(), onEmpty)("5", done);
    inputInstances[0].onSubmit!("unlimited");
    expect(onEmpty).toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith("(not set)");
  });

  it("errors on empty input when required", () => {
    const ctx = createMockCtx();
    const done = vi.fn();
    createNumericSubmenu(ctx, { min: 1, required: true })("5", done);
    inputInstances[0].onSubmit!("");
    expect(ctx.ui.notify).toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });
});
