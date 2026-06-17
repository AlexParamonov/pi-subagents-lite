# Task Result: Fix architecture review BLOCK

**Status:** COMPLETE

**What changed:**
- `AgentConfig.skills/extensions` made optional (`undefined` = not set, subject to global default)
- `BASE_DEFAULTS` no longer hardcodes `skills: true` / `extensions: true`
- `DEFAULT_AGENTS` (`general-purpose`, `Explore`) no longer hardcode `skills: true` / `extensions: true`
- `applyGlobalDefaults` resolves `undefined` from global default, passes concrete values through unchanged
- Absolute fallback in `getConfig` uses `undefined` instead of `true`
- Fixed 3 tests that asserted incorrect behavior, added 2 new tests for implicit agents

**Files modified:**
- `src/types.ts` — `skills` and `extensions` now optional in `AgentConfig`
- `src/agents/agent-discovery.ts` — removed `skills/extensions: true` from `BASE_DEFAULTS`
- `src/agents/agent-types.ts` — `applyGlobalDefaults` handles `undefined`, `toUpdated` passes through optionality
- `src/agents/default-agents.ts` — removed `skills/extensions: true` from both default agents
- `test/agent-types-resolver.test.ts` — inverted 2 wrong assertions, fixed 1 fixture, added 2 new tests

**Tests:** 738/738 pass (39 files)

**Typecheck:** Pre-existing error in `menu-system-prompt.ts:29` (not in scope, untouched file)

**BLOCK reasons addressed:**
1. ✅ `AgentConfig` can now represent "not set" via `undefined`
2. ✅ Explicit `skills: true` passes through `applyGlobalDefaults` unchanged
3. ✅ Agent with no `skills/extensions` set uses the global default
4. ✅ Embedded default agents inherit global default (behavior change when `"none"` is set)
5. ✅ Test asserting `skills: true → false` under `"none"` is inverted

**Blockers:** None
