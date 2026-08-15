/**
 * pi-settings.test.ts — readPiSettings / getHideThinkingBlock against real fs
 * with a spied home dir, exercising the exact production path
 * (~/.pi/agent/settings.json) with real JSON parsing and ENOENT handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readPiSettings, getHideThinkingBlock, readDefaultTools } from "../src/pi-settings.js";
import { tempDirFixture } from "./fixtures";

// node:os is externalized (not configurable for spies) — mock only homedir
// and keep the rest of the module real (tmpdir feeds the temp fixture).
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: vi.fn(),
}));

describe("PiSettings", () => {
  const { setup, teardown } = tempDirFixture("pi-settings-test");
  let homeDir: string;

  beforeEach(() => {
    homeDir = setup();
    vi.mocked(os.homedir).mockReturnValue(homeDir);
  });

  afterEach(() => {
    teardown();
  });

  const writeSettings = (content: string): void => {
    const dir = path.join(homeDir, ".pi", "agent");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.json"), content);
  };

  describe("readPiSettings", () => {
    it("returns parsed settings from ~/.pi/agent/settings.json", () => {
      writeSettings(JSON.stringify({ hideThinkingBlock: true }));

      expect(readPiSettings()).toEqual({ hideThinkingBlock: true });
    });

    it("returns undefined when the file does not exist", () => {
      expect(readPiSettings()).toBeUndefined();
    });

    it("returns undefined when the JSON is invalid", () => {
      writeSettings("not json");

      expect(readPiSettings()).toBeUndefined();
    });
  });

  describe("getHideThinkingBlock", () => {
    it("returns true when hideThinkingBlock is true", () => {
      writeSettings(JSON.stringify({ hideThinkingBlock: true }));

      expect(getHideThinkingBlock()).toBe(true);
    });

    it("returns false when hideThinkingBlock is false", () => {
      writeSettings(JSON.stringify({ hideThinkingBlock: false }));

      expect(getHideThinkingBlock()).toBe(false);
    });

    it("returns false when the setting is missing", () => {
      writeSettings(JSON.stringify({}));

      expect(getHideThinkingBlock()).toBe(false);
    });

    it("returns false when the file cannot be read", () => {
      expect(getHideThinkingBlock()).toBe(false);
    });
  });
});

/* ------------------------------------------------------------------ */
/*  readDefaultTools                                                  */
/* ------------------------------------------------------------------ */

describe("readDefaultTools", () => {
  it("returns the accessor's value when pi exposes getDefaultTools", () => {
    const manager = { getDefaultTools: () => ["read", "bash"] };
    expect(readDefaultTools(manager as any)).toEqual(["read", "bash"]);
  });

  it("reads the merged settings field when pi lacks getDefaultTools (pi < 0.84.2)", () => {
    const manager = { settings: { defaultTools: ["read", "bash", "grep"] } };
    expect(readDefaultTools(manager as any)).toEqual(["read", "bash", "grep"]);
  });

  it("returns undefined when the setting is unconfigured on either path", () => {
    expect(readDefaultTools({ settings: {} } as any)).toBeUndefined();
    expect(readDefaultTools({ getDefaultTools: () => undefined } as any)).toBeUndefined();
  });

  it("keeps an explicitly empty [] distinct from unconfigured", () => {
    expect(readDefaultTools({ settings: { defaultTools: [] } } as any)).toEqual([]);
    expect(readDefaultTools({ getDefaultTools: () => [] } as any)).toEqual([]);
  });

  it("degrades to undefined when the merged field holds a non-array", () => {
    expect(readDefaultTools({ settings: { defaultTools: null } } as any)).toBeUndefined();
  });

  it("returns a copy so callers cannot mutate the manager's state", () => {
    const shared = ["read"];
    const manager = { getDefaultTools: () => shared };
    const tools = readDefaultTools(manager as any)!;
    tools.push("bash");
    expect(shared).toEqual(["read"]);
  });
});
