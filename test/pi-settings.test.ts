/**
 * pi-settings.test.ts — Tests for PiSettings module.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("node:fs");
vi.mock("node:os");

const mockFs = vi.mocked(fs);
const mockOs = vi.mocked(os);

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { readPiSettings, getHideThinkingBlock } from "../../src/pi-settings.js";

describe("PiSettings", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = "/tmp/test-home";
    mockOs.homedir.mockReturnValue(tempHome);
    vi.clearAllMocks();
  });

  describe("readPiSettings", () => {
    it("returns parsed settings when file exists", () => {
      const settings = { hideThinkingBlock: true };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(settings));

      const result = readPiSettings();

      expect(result).toEqual(settings);
      expect(mockFs.readFileSync).toHaveBeenCalledWith(path.join(tempHome, ".pi", "agent", "settings.json"), "utf-8");
    });

    it("returns undefined when file doesn't exist", () => {
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const result = readPiSettings();

      expect(result).toBeUndefined();
    });

    it("returns undefined when JSON is invalid", () => {
      mockFs.readFileSync.mockReturnValue("invalid json");

      const result = readPiSettings();

      expect(result).toBeUndefined();
    });
  });

  describe("getHideThinkingBlock", () => {
    it("returns true when hideThinkingBlock is true", () => {
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ hideThinkingBlock: true }));

      const result = getHideThinkingBlock();

      expect(result).toBe(true);
    });

    it("returns false when hideThinkingBlock is false", () => {
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ hideThinkingBlock: false }));

      const result = getHideThinkingBlock();

      expect(result).toBe(false);
    });

    it("returns false when setting is missing", () => {
      mockFs.readFileSync.mockReturnValue(JSON.stringify({}));

      const result = getHideThinkingBlock();

      expect(result).toBe(false);
    });

    it("returns false when file can't be read", () => {
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const result = getHideThinkingBlock();

      expect(result).toBe(false);
    });
  });
});
