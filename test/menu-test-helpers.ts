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
import type { ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

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

/** The type for a mock ui.custom override that matches ExtensionUIContext["custom"]
 * while accepting the simpler ComponentFactory parameter shape in tests.
 * tui is optional to satisfy contravariance with the full TUI type. */
export type CustomMockFn = (
  factory?: (
    tui?: { terminal: { rows: number } },
    theme?: {
      fg: (color: string, text: string) => string;
      bold: (text: string) => string;
      italic?: (text: string) => string;
    },
    keybindings?: unknown,
    done?: (result: unknown) => void,
  ) => unknown,
) => Promise<unknown>;

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

/** Shallow-merge two objects: source values win over defaults for each key. */
function shallowMerge<T>(defaults: T, overrides: Partial<T>): T {
  const result: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  for (const key of Object.keys(overrides) as string[]) {
    const val = (overrides as Record<string, unknown>)[key];
    if (val !== undefined) result[key] = val;
  }
  return result as T;
}

/** Default fake UI context with all required ExtensionUIContext members. */
const defaultUi: ExtensionUIContext = {
  select: vi.fn(async () => undefined),
  confirm: vi.fn(async () => false),
  input: vi.fn(async () => undefined),
  notify: vi.fn(),
  onTerminalInput: vi.fn(() => () => {}),
  setStatus: vi.fn(),
  setWorkingMessage: vi.fn(),
  setWorkingVisible: vi.fn(),
  setWorkingIndicator: vi.fn(),
  setHiddenThinkingLabel: vi.fn(),
  setWidget: vi.fn() as ExtensionUIContext["setWidget"],
  setFooter: vi.fn() as ExtensionUIContext["setFooter"],
  setHeader: vi.fn() as ExtensionUIContext["setHeader"],
  setTitle: vi.fn(),
  custom: vi.fn(async () => undefined) as ExtensionUIContext["custom"],
  pasteToEditor: vi.fn(),
  setEditorText: vi.fn(),
  getEditorText: vi.fn(() => ""),
  editor: vi.fn(async () => undefined),
  addAutocompleteProvider: vi.fn(),
  setEditorComponent: vi.fn() as ExtensionUIContext["setEditorComponent"],
  getEditorComponent: vi.fn(() => undefined) as ExtensionUIContext["getEditorComponent"],
  theme: {
    fg: vi.fn(),
    bg: vi.fn(),
    bold: vi.fn(),
    italic: vi.fn(),
    dim: vi.fn(),
    underline: vi.fn(),
    inverse: vi.fn(),
    strikethrough: vi.fn(),
  } as never,
  getAllThemes: vi.fn(() => []),
  getTheme: vi.fn(() => undefined),
  setTheme: vi.fn(() => ({ success: true })),
  getToolsExpanded: vi.fn(() => false),
  setToolsExpanded: vi.fn(),
};

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

  const notifyMock = vi.fn();

  const defaults: ExtensionCommandContext = {
    ui: {
      select: selectMock as ExtensionUIContext["select"],
      confirm: vi.fn(async () => false),
      input: inputMock as ExtensionUIContext["input"],
      notify: notifyMock,
      onTerminalInput: vi.fn(() => () => {}),
      setStatus: vi.fn(),
      setWorkingMessage: vi.fn(),
      setWorkingVisible: vi.fn(),
      setWorkingIndicator: vi.fn(),
      setHiddenThinkingLabel: vi.fn(),
      setWidget: vi.fn() as ExtensionUIContext["setWidget"],
      setFooter: vi.fn() as ExtensionUIContext["setFooter"],
      setHeader: vi.fn() as ExtensionUIContext["setHeader"],
      setTitle: vi.fn(),
      custom: defaultCustom,
      pasteToEditor: vi.fn(),
      setEditorText: vi.fn(),
      getEditorText: vi.fn(() => ""),
      editor: vi.fn(async () => undefined),
      addAutocompleteProvider: vi.fn(),
      setEditorComponent: vi.fn() as ExtensionUIContext["setEditorComponent"],
      getEditorComponent: vi.fn(() => undefined) as ExtensionUIContext["getEditorComponent"],
      theme: {
        fg: vi.fn(),
        bg: vi.fn(),
        bold: vi.fn(),
        italic: vi.fn(),
        dim: vi.fn(),
        underline: vi.fn(),
        inverse: vi.fn(),
        strikethrough: vi.fn(),
      } as never,
      getAllThemes: vi.fn(() => []),
      getTheme: vi.fn(() => undefined),
      setTheme: vi.fn(() => ({ success: true })),
      getToolsExpanded: vi.fn(() => false),
      setToolsExpanded: vi.fn(),
    },
    mode: "tui",
    hasUI: true,
    cwd: "/home/test",
    sessionManager: {
      getActive: vi.fn(() => undefined),
      getInfo: vi.fn(() => undefined),
      getCwd: vi.fn(() => "/home/test"),
      getSessionDir: vi.fn(() => "/home/test/.pi/sessions"),
      getSessionId: vi.fn(() => "session-1"),
      getSessionFile: vi.fn(() => "/home/test/.pi/sessions/session.json"),
      getLeafId: vi.fn(() => "leaf-1"),
      getLeafEntry: vi.fn(() => undefined),
      getEntry: vi.fn(() => undefined),
      getLabel: vi.fn(() => "test"),
      getBranch: vi.fn(() => []),
      buildContextEntries: vi.fn(() => []),
      getHeader: vi.fn(() => ({})),
      getEntries: vi.fn(() => []),
      getTree: vi.fn(() => []),
      getSessionName: vi.fn(() => "test-session"),
    } as unknown as ExtensionCommandContext["sessionManager"],
    modelRegistry: {
      find: vi.fn(),
      list: vi.fn(() => []),
      getAll: vi.fn(() => []),
      getAvailable: vi.fn(() => [
        { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        { provider: "openai", id: "gpt-4o" },
      ]),
      refresh: vi.fn(async () => ({})),
      getError: vi.fn(() => undefined),
      hasConfiguredAuth: vi.fn(() => false),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: false, error: "mock" })),
      getProviderAuthStatus: vi.fn(() => ({})),
      getProvider: vi.fn(() => undefined),
      complete: vi.fn(async () => ({})),
      getProviderDisplayName: vi.fn(() => "mock"),
      getProviderAuth: vi.fn(async () => undefined),
      getApiKeyForProvider: vi.fn(async () => undefined),
      isUsingOAuth: vi.fn(() => false),
      registerProvider: vi.fn(),
      unregisterProvider: vi.fn(),
      getRegisteredProviderConfig: vi.fn(() => undefined),
      getRegisteredNativeProvider: vi.fn(() => undefined),
      getRegisteredProviderIds: vi.fn(() => []),
    } as unknown as ExtensionCommandContext["modelRegistry"],
    model: { provider: "test", id: "model" } as unknown as ExtensionCommandContext["model"],
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

  // Handle ui.custom separately: cast the looser override type to the real type
  if (options.ui?.custom !== undefined) {
    // The override type is compatible at runtime; the structural mismatch is
    // due to the generic T in ExtensionUIContext["custom"].
    Object.assign(defaults.ui, { custom: options.ui.custom });
  }
  const { custom: _, ...uiRest } = options.ui ?? {};
  const mergedOptions = {
    ...options,
    ui: Object.keys(uiRest).length > 0 ? uiRest : undefined,
  } as Partial<ExtensionCommandContext>;
  return shallowMerge(defaults, mergedOptions);
}
