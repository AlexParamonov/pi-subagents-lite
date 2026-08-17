/**
 * mock-utils.ts — Shared mock utilities for test fixtures.
 *
 * Extracted from fixtures.ts and menu-test-helpers.ts to avoid duplication.
 * Exports:
 *   - shallowMerge: shallow-merge two objects with optional undefined skipping
 *   - defaultUi: default ExtensionUIContext with all required members as stubs
 *   - defaultSessionManager: default ReadonlySessionManager with typed stubs
 *   - defaultModel: default model config object
 *   - defaultModelRegistry: default ModelRegistry mock (declare class, needs cast)
 */

import { vi } from "vitest";
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/**
 * Shallow-merge two objects: source values win over defaults for each key.
 * @param skipUndefined When true (default), undefined values in overrides are ignored.
 *                      When false, undefined values override defaults.
 */
export function shallowMerge<T>(defaults: T, overrides: Partial<T>, skipUndefined = true): T {
  const result: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  for (const key of Object.keys(overrides) as string[]) {
    const val = (overrides as Record<string, unknown>)[key];
    if (!skipUndefined || val !== undefined) result[key] = val;
  }
  return result as T;
}

/** Default fake UI context with all required ExtensionUIContext members as stubs. */
export const defaultUi: ExtensionUIContext = {
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

/** Default ReadonlySessionManager with typed stubs for all required methods. */
export function defaultSessionManager(): ExtensionContext["sessionManager"] {
  return {
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
    getHeader: vi.fn(() => ({
      type: "session" as const,
      id: "session-1",
      timestamp: "2024-01-01T00:00:00Z",
      cwd: "/home/test",
    })),
    getEntries: vi.fn(() => []),
    getTree: vi.fn(() => []),
    getSessionName: vi.fn(() => "test-session"),
  } as unknown as ExtensionContext["sessionManager"];
}

/** Default model config object. */
export function defaultModel(): ExtensionContext["model"] {
  return {
    provider: "test",
    id: "model",
    name: "Test Model",
    api: "anthropic-messages",
    baseUrl: "https://api.test.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 8192,
  };
}

/** Default ModelRegistry mock (declare class, cannot be structurally satisfied). */
export function defaultModelRegistry(
  overrides: Partial<Record<string, unknown>> = {},
): ExtensionContext["modelRegistry"] {
  const base: Record<string, unknown> = {
    find: vi.fn(),
    list: vi.fn(() => []),
    getAll: vi.fn(() => []),
    getAvailable: vi.fn(() => []),
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
    ...overrides,
  };
  // ModelRegistry is a declare class; structural satisfaction is impossible.
  return base as unknown as ExtensionContext["modelRegistry"];
}
