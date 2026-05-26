/**
 * config-migration.ts — Pure function migration from subagent-model-defaults.json to subagents.json.
 *
 * Pure function — no file I/O, no side effects. The actual file operations
 * (read old, write new, rename old to .bak) live in index.ts (Batch 5).
 */

import type { SubagentsConfig } from "./model-precedence.js";

/** Default concurrency limit when migrating from old config format. */
const DEFAULT_CONCURRENCY = 4;

/** Old config format from subagent-model-defaults.json. */
export interface OldConfig {
  default: string | null | undefined;
  overrides: Record<string, string>;
}

/**
 * Migrate an old-format config to the new SubagentsConfig format.
 *
 * - `default` → `agent.default` (null if undefined)
 * - `overrides` entries → `agent[type]` entries
 * - `concurrency.default` set to DEFAULT_CONCURRENCY (4)
 *
 * @param oldConfig - The old-format config object
 * @returns A new SubagentsConfig object (no mutation of input)
 */
export function migrateConfig(oldConfig: OldConfig): SubagentsConfig {
  const agent: Record<string, string | null> = {
    default: oldConfig.default ?? null,
  };

  for (const [type, model] of Object.entries(oldConfig.overrides)) {
    agent[type] = model;
  }

  return {
    agent,
    concurrency: {
      default: DEFAULT_CONCURRENCY,
    },
  };
}
