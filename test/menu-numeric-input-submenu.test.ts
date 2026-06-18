/**
 * Tests for createNumericInputSubmenu — shared numeric input submenu Component.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

let inputInstances: Array<{
  value: string;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  setValue: (v: string) => void;
  getValue: () => string;
}> = [];

vi.mock("../src/ui/menu/menu-helpers.js", () => ({
  validateNumeric: (value: string, min: number) => {
    const parsed = parseInt(value.trim(), 10);
    if (isNaN(parsed) || parsed < min) return undefined;
    return parsed;
  },
}));

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList { constructor() {} },
  Input: class MockInput {
    value = "";
    onSubmit?: (value: string) => void;
    onEscape?: () => void;
    setValue(v: string) { this.value = v; }
    getValue() { return this.value; }
    constructor() { inputInstances.push(this as any); }
  },
}));

import { createNumericInputSubmenu } from "../src/ui/menu/menu-numeric-input-submenu.js";

describe("createNumericInputSubmenu", () => {
  beforeEach(() => {
    inputInstances = [];
    vi.clearAllMocks();
  });

  it("returns a function that creates an Input component", () => {
    const factory = createNumericInputSubmenu({
      min: 1,
      minLabel: "≥ 1",
      onValid: vi.fn(),
      onError: vi.fn(),
    });
    expect(typeof factory).toBe("function");

    const component = factory("5", vi.fn());
    expect(inputInstances.length).toBe(1);
    expect(inputInstances[0].value).toBe("5");
  });

  it("calls onValid and done with parsed value on valid submit", () => {
    const onValid = vi.fn();
    const done = vi.fn();
    const factory = createNumericInputSubmenu({
      min: 1,
      minLabel: "≥ 1",
      onValid,
      onError: vi.fn(),
    });
    factory("5", done);
    inputInstances[0].onSubmit!("10");
    expect(onValid).toHaveBeenCalledWith(10);
    expect(done).toHaveBeenCalledWith("10");
  });

  it("calls onError and does NOT call done on invalid submit", () => {
    const onValid = vi.fn();
    const onError = vi.fn();
    const done = vi.fn();
    const factory = createNumericInputSubmenu({
      min: 1,
      minLabel: "≥ 1",
      onValid,
      onError,
    });
    factory("5", done);
    inputInstances[0].onSubmit!("0");
    expect(onError).toHaveBeenCalledWith("Invalid value — must be a number ≥ 1");
    expect(onValid).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it("rejects non-numeric input", () => {
    const onError = vi.fn();
    const done = vi.fn();
    const factory = createNumericInputSubmenu({
      min: 0,
      minLabel: "≥ 0",
      onValid: vi.fn(),
      onError,
    });
    factory("5", done);
    inputInstances[0].onSubmit!("abc");
    expect(onError).toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it("accepts value at exact minimum", () => {
    const onValid = vi.fn();
    const done = vi.fn();
    const factory = createNumericInputSubmenu({
      min: 5,
      minLabel: "≥ 5",
      onValid,
      onError: vi.fn(),
    });
    factory("5", done);
    inputInstances[0].onSubmit!("5");
    expect(onValid).toHaveBeenCalledWith(5);
    expect(done).toHaveBeenCalledWith("5");
  });

  it("calls done() without argument on escape", () => {
    const done = vi.fn();
    const factory = createNumericInputSubmenu({
      min: 1,
      minLabel: "≥ 1",
      onValid: vi.fn(),
      onError: vi.fn(),
    });
    factory("5", done);
    inputInstances[0].onEscape!();
    expect(done).toHaveBeenCalledWith();
  });
});
