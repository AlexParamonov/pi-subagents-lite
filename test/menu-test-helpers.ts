/**
 * menu-test-helpers.ts — Shared pure helpers for menu tests.
 *
 * Exports only pure utility functions. Mock setup (vi.hoisted, vi.mock)
 * must be declared in each test file because vitest requires them at
 * the module level of the test file itself.
 *
 * Exports:
 *   - createMockCtx: create a mock ExtensionCommandContext with controllable UI
 *   - selectByName: helper to select menu items by short name
 */

import { vi, type Mock } from "vitest";

/** The ui.custom component factory as the mock invokes it: the real
 * (tui, theme, keybindings, done) signature with test-fake argument shapes
 * (the real TUI/Theme/KeybindingsManager are not constructible fakes here).
 * Theme members mirror src's Theme: only fg/bold are required, so each
 * menu test's theme fake can provide just the functions its menu uses. */
export type ComponentFactory = (
  tui: { terminal: { rows: number } },
  theme: {
    fg: (color: string, text: string) => string;
    bold: (text: string) => string;
    italic?: (text: string) => string;
  },
  keybindings: unknown,
  done: (result: unknown) => void,
) => unknown;

/** The controllable fake half of the mock command context. */
export interface MockCommandContext {
  ui: {
    select: Mock<(title: string, items: string[]) => Promise<string | undefined>>;
    input: Mock<(label: string, initialValue?: string) => Promise<string | undefined>>;
    custom: Mock<(factory: ComponentFactory) => Promise<string | null | undefined>>;
    notify: Mock;
  };
  modelRegistry: { getAvailable: Mock<() => Array<{ provider: string; id: string }>> };
}

/**
 * Select menu item by partial name match.
 * Maps short names to menu items: 'model', 'concurrency', 'running', 'widget', 'debug'
 */
export function selectByName(name: string): (title: string, items: string[]) => string | undefined {
  const nameMap: Record<string, string> = {
    model: "Model settings",
    concurrency: "Concurrency settings",
    running: "Running agents",
    widget: "Widget settings",
    debug: "Debug",
    settings: "Settings",
    spawn: "Spawn agent",
    spawnoptions: "Spawn options",
  };
  const search = nameMap[name.toLowerCase()] ?? name;
  return (_title: string, items: string[]) => {
    const match = items.find((item) => item.toLowerCase().includes(search.toLowerCase()));
    return match ?? undefined;
  };
}

/**
 * Create a mock extension command context with controllable UI.
 *
 * The return type stays `any` (not ExtensionCommandContext): the menu test
 * suites reassign `ctx.ui.custom` with bare `vi.fn()` mocks, which the real
 * generic `ui.custom` signature (present in any ExtensionCommandContext-typed
 * intersection) rejects (reproduced: TS2322 at the reassignment sites). No
 * non-any type both accepts those reassignments and stays assignable to
 * ExtensionCommandContext for the show*Menu calls.
 *
 * @param selections Array of values that ctx.ui.select returns sequentially.
 * @param inputs Array of values that ctx.ui.input returns sequentially.
 * @param customValues Array of values that ctx.ui.custom returns sequentially.
 */
export function createMockCtx(
  selections: (string | ((title: string, items: string[]) => string | undefined) | undefined)[] = [],
  inputs: (string | undefined)[] = [],
  customValues: (string | null)[] = [],
): any {
  let selectIdx = 0;
  let inputIdx = 0;
  let customIdx = 0;

  const fake: MockCommandContext = {
    ui: {
      select: vi.fn(async (title: string, items: string[]) => {
        const sel = selections[selectIdx++];
        if (typeof sel === "function") return sel(title, items);
        return sel ?? undefined;
      }),
      input: vi.fn(async (_label: string, _initialValue?: string) => {
        return inputs[inputIdx++] ?? undefined;
      }),
      custom: vi.fn(async (_factory: ComponentFactory) => {
        // If customValues have explicit entries, return those
        if (customIdx < customValues.length) {
          return customValues[customIdx++];
        }
        // Otherwise, invoke the factory to trigger side effects (e.g. ResultViewer construction)
        // Provide a mock tui with terminal.rows, a noop theme, and a done callback
        _factory(
          { terminal: { rows: 40 } },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
            italic: (text: string) => text,
          },
          null,
          () => {},
        );
        return undefined;
      }),
      notify: vi.fn(),
    },
    modelRegistry: {
      getAvailable: vi.fn(() => [
        { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        { provider: "openai", id: "gpt-4o" },
      ]),
    },
  };
  return fake;
}
