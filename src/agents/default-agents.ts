/**
 * default-agents.ts — Bundled Markdown default agent configurations.
 *
 * These are the lowest-precedence agents and can be overridden by user .md
 * files with the same name.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgentFile, toAgentConfig } from "./agent-discovery.js";
import type { AgentConfig } from "./types.js";

const DEFAULT_AGENT_NAMES = ["explorer", "scout", "implementer", "reviewer", "verifier"] as const;
const defaultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "defaults");

function loadDefaultAgents(): Map<string, AgentConfig> {
  return new Map(DEFAULT_AGENT_NAMES.map((name) => {
    const content = fs.readFileSync(path.join(defaultsDir, `${name}.md`), "utf-8");
    const config = toAgentConfig(parseAgentFile(content, "default"));
    return [name, { ...config, isDefault: true }];
  }));
}

export const DEFAULT_AGENTS = loadDefaultAgents();
