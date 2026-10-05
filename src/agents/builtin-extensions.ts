/**
 * pi's built-in extensions for child sessions, via the public SDK creators,
 * wrapped the way pi's CLI registry carries them (builtin + replaceable).
 * Passed unconditionally to every child loader: pi's loader applies the
 * settings-level selection and replaceability itself. llama.cpp has no
 * sanctioned creator and is excluded.
 */

import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

export interface BuiltinExtensionFactory {
  name: string;
  factory: ExtensionFactory;
  builtin: true;
  replaceable: true;
}

export const BUILTIN_EXTENSION_FACTORIES: BuiltinExtensionFactory[] = [
  { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
  { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
  { name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
];
