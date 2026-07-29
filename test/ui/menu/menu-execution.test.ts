import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockModules } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";

let settingsLists: any[] = [];
let inputs: any[] = [];

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList {
    items: any[];
    onChange: (id: string, value: string) => void;
    constructor(items: any[], _max: number, _theme: any, onChange: (id: string, value: string) => void) {
      this.items = items;
      this.onChange = onChange;
      settingsLists.push(this);
    }
  },
  Input: class MockInput {
    value = "";
    onSubmit?: (value: string) => void;
    onEscape?: () => void;
    constructor() { inputs.push(this); }
    setValue(value: string) { this.value = value; }
    getValue() { return this.value; }
  },
}));

import { showExecutionMenu } from "../../../src/ui/menu/menu-execution.js";

describe("showExecutionMenu", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false, defaultMaxTurns: undefined };
    mockModules.mockConfig.concurrency = { default: 4 };
    settingsLists = [];
    inputs = [];
    vi.clearAllMocks();
  });

  it("contains only the three common execution defaults", async () => {
    await showExecutionMenu(createMockCtx());
    expect(settingsLists[0].items.map((item: any) => item.id)).toEqual([
      "defaultConcurrency", "forceBackground", "defaultMaxTurns",
    ]);
  });

  it("updates force-background and default concurrency", async () => {
    const ctx = createMockCtx();
    await showExecutionMenu(ctx);
    settingsLists[0].onChange("forceBackground", "ON");
    expect(mockModules.mockConfig.agent.forceBackground).toBe(true);

    const concurrency = settingsLists[0].items.find((item: any) => item.id === "defaultConcurrency");
    concurrency.submenu("4", vi.fn());
    inputs[0].onSubmit("7");
    expect(mockModules.mockConfig.concurrency.default).toBe(7);
  });

  it("sets and clears the default max-turn limit", async () => {
    await showExecutionMenu(createMockCtx());
    const maxTurns = settingsLists[0].items.find((item: any) => item.id === "defaultMaxTurns");

    maxTurns.submenu("(not set)", vi.fn());
    inputs[0].onSubmit("30");
    expect(mockModules.mockConfig.agent.defaultMaxTurns).toBe(30);

    maxTurns.submenu("30", vi.fn());
    inputs[1].onSubmit("");
    expect(mockModules.mockConfig.agent.defaultMaxTurns).toBeUndefined();
  });
});
