/**
 * validate-numeric.test.ts — Tests for validateNumeric helper.
 */

import { describe, it, expect } from "vitest";
import { validateNumeric } from "../src/ui/menu/menu-helpers.js";

describe("validateNumeric", () => {
  it("returns parsed integer for valid input", () => {
    expect(validateNumeric("10", 2)).toBe(10);
  });

  it("returns parsed integer at minimum boundary", () => {
    expect(validateNumeric("2", 2)).toBe(2);
  });

  it("returns undefined for value below minimum", () => {
    expect(validateNumeric("1", 2)).toBeUndefined();
  });

  it("returns undefined for non-numeric input", () => {
    expect(validateNumeric("abc", 2)).toBeUndefined();
  });

  it("trims whitespace before parsing", () => {
    expect(validateNumeric("  10  ", 2)).toBe(10);
  });

  it("returns undefined for empty string", () => {
    expect(validateNumeric("", 2)).toBeUndefined();
  });

  it("handles min of 1", () => {
    expect(validateNumeric("1", 1)).toBe(1);
    expect(validateNumeric("0", 1)).toBeUndefined();
  });
});
