/**
 * mock-utils.ts — Shared mock utilities for test fixtures.
 *
 * Extracted from fixtures.ts and menu-test-helpers.ts to avoid duplication.
 * Exports:
 *   - shallowMerge: shallow-merge two objects with optional undefined skipping
 *   - defaultUi: default ExtensionUIContext with all required members as stubs
 */

import { vi } from "vitest";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

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
