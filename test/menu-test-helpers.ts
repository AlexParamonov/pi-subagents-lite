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

import { vi } from "vitest";
import type { ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { defaultUi, defaultSessionManager, defaultModel, defaultModelRegistry } from "./mock-utils.js";

/** The ui.custom component factory as the mock invokes it: the real
 * (tui, theme, keybindings, done) signature with test-fake argument shapes
 * (the real TUI/Theme/KeybindingsManager are not constructible fakes here).
 * Theme members mirror src's Theme: only fg/bold are required, so each
 * menu test's theme fake can provide just the functions its menu uses.
 * Parameters are optional to match the override type's contravariant shape. */
export type ComponentFactory = (
  tui?: { terminal: { rows: number } },
  theme?: {
    fg: (color: string, text: string) => string;
    bold: (text: string) => string;
    italic?: (text: string) => string;
  },
  keybindings?: unknown,
  done?: (result: unknown) => void,
) => unknown;

/** Options for overriding specific fields of the default fake command context.
 * ui.custom uses a looser type to accommodate test mocks; cast to the real
 * type at the call site when overriding ui.custom. */
export interface CreateMockCtxOptions {
  ui?: Partial<Omit<ExtensionUIContext, "custom">> & {
    custom?: unknown;
  };
  modelRegistry?: ExtensionCommandContext["modelRegistry"];
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
 * Returns a fully typed ExtensionCommandContext with typed defaults for all
 * required fields. Pass an options object to override specific fields.
 *
 * @param selections Array of values that ctx.ui.select returns sequentially.
 * @param inputs Array of values that ctx.ui.input returns sequentially.
 * @param customValues Array of values that ctx.ui.custom returns sequentially.
 * @param options Override specific fields of the mock context.
 */
export function createMockCtx(
  selections: (string | ((title: string, items: string[]) => string | undefined) | undefined)[] = [],
  inputs: (string | undefined)[] = [],
  customValues: (string | null)[] = [],
  options: CreateMockCtxOptions = {},
): ExtensionCommandContext {
  let selectIdx = 0;
  let inputIdx = 0;
  let customIdx = 0;

  const selectMock = vi.fn(async (title: string, items: string[]) => {
    const sel = selections[selectIdx++];
    if (typeof sel === "function") return sel(title, items);
    return sel ?? undefined;
  });

  const inputMock = vi.fn(async (_label: string, _initialValue?: string) => {
    return inputs[inputIdx++] ?? undefined;
  });

  const defaultCustom = vi.fn(async (factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
    if (customIdx < customValues.length) {
      return customValues[customIdx++];
    }
    // Invoke the factory to trigger side effects (e.g. ResultViewer construction)
    if (factory) {
      const component = await (
        factory as (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => unknown
      )(
        { terminal: { rows: 40 } },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text },
        null,
        () => {},
      );
      void component;
    }
    return undefined;
  }) as ExtensionUIContext["custom"];

  // Build UI by overriding defaultUi's select/input/custom with controllable mocks.
  const ui: ExtensionUIContext = {
    ...defaultUi,
    select: selectMock as ExtensionUIContext["select"],
    input: inputMock as ExtensionUIContext["input"],
    custom: defaultCustom,
  };

  const defaults: ExtensionCommandContext = {
    ui,
    mode: "tui",
    hasUI: true,
    cwd: "/home/test",
    sessionManager: defaultSessionManager(),
    modelRegistry:
      options.modelRegistry ??
      defaultModelRegistry({
        getAvailable: vi.fn(() => [
          { provider: "anthropic", id: "claude-sonnet-4-20250514" },
          { provider: "openai", id: "gpt-4o" },
        ]),
      }),
    model: defaultModel(),
    scopedModels: [],
    isIdle: vi.fn(() => true),
    isProjectTrusted: vi.fn(() => true),
    signal: undefined,
    abort: vi.fn(),
    hasPendingMessages: vi.fn(() => false),
    shutdown: vi.fn(),
    getContextUsage: vi.fn(() => undefined),
    compact: vi.fn(),
    getSystemPrompt: vi.fn(() => ""),
    getSystemPromptOptions: vi.fn(() => ({}) as never),
    waitForIdle: vi.fn(async () => {}),
    newSession: vi.fn(async () => ({ cancelled: false })),
    fork: vi.fn(async () => ({ cancelled: false })),
    navigateTree: vi.fn(async () => ({ cancelled: false })),
    switchSession: vi.fn(async () => ({ cancelled: false })),
    reload: vi.fn(async () => {}),
  };

  // Handle ui.custom override: the looser type is compatible at runtime;
  // the structural mismatch is due to the generic T in ExtensionUIContext["custom"].
  if (options.ui?.custom !== undefined) {
    Object.assign(defaults.ui, { custom: options.ui.custom });
  }
  const { custom: _, ...uiRest } = options.ui ?? {};
  if (Object.keys(uiRest).length > 0) {
    Object.assign(defaults.ui, uiRest);
  }
  return defaults;
}
