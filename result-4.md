# Slice Result: skills-extensions-default-config

**Status:** COMPLETE

**What was built:**
- `loadSkillsImplicitly` and `loadExtensionsImplicitly` global config fields (`"load-all"` | `"none"`, default `"load-all"`)
- ConfigStore getters and mutate methods for both fields
- `getConfig()` applies global defaults when agent has `skills: true` / `extensions: true` (the implicit default)
- Explicit agent config (`false`, `string[]`) always overrides the global default
- System Prompt menu toggles: `Load skills implicitly · ON/OFF` and `Load extensions implicitly · ON/OFF`
- Config persists in `~/.pi/agent/subagents-lite.json`

**Files created/modified:**
- `src/models/model-precedence.ts` — added fields to `SubagentsConfig` type
- `src/types.ts` — added keys to `CONFIG_AGENT_NON_MODEL_KEYS`
- `src/config/config-store.ts` — added resolved getters and mutate methods
- `src/agents/agent-types.ts` — `getConfig()` applies global defaults via `applyGlobalDefaults()`
- `src/agents/agent-runner.ts` — passes store's global defaults to `getConfig()`
- `src/ui/menu/menu-system-prompt.ts` — added two toggle menu items
- `test/config-store.test.ts` — 10 new tests for config store reads/mutations
- `test/menu-system-prompt.test.ts` — 8 new tests for menu toggles
- `test/agent-types-resolver.test.ts` — 7 new tests for getConfig global default behavior
- `test/menu-mock-setup.ts` — updated mock to include new fields

**Tests added:**
- 25 new tests (10 config-store + 8 menu + 7 getConfig)
- Total: 736 tests passing (up from 711)

**Acceptance criteria:**
- [x] `loadSkillsImplicitly` config field accepts `"load-all"` | `"none"`, defaults to `"load-all"`
- [x] `loadExtensionsImplicitly` config field accepts `"load-all"` | `"none"`, defaults to `"load-all"`
- [x] Agent with no explicit `skills`/`extensions` in .md uses the global default
- [x] Agent with explicit `skills: true`/`skills: false`/`skills: [...]` ignores the global default
- [x] Agent with explicit `extensions: true`/`extensions: false`/`extensions: [...]` ignores the global default
- [x] System Prompt menu shows `Load skills implicitly · ON` (or `OFF`)
- [x] System Prompt menu shows `Load extensions implicitly · ON` (or `OFF`)
- [x] Clicking the menu item toggles between ON and OFF
- [x] Config persists in `~/.pi/agent/subagents-lite.json`
- [x] Existing agents with no config change continue to load all (backward compatible)

**Design note:**
- When an agent has `skills: true` (the default for all built-in and base agents) and the global setting is `"none"`, the global default wins. This is the correct behavior because `true` is the implicit default, not an explicit agent override. Agents with `skills: false` or `skills: ["specific"]` always override the global.

**Deviations (if any):**
- None

**Blockers (if any):**
- None

**Research needed (if any):**
- None
