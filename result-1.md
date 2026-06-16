# Slice Result: unify-tool-visibility

**Status:** COMPLETE

**What was built:**
- `resolveVisibleTools()` function in `agent-types.ts`: single owner of tool visibility policy
- `EXCLUDED_TOOL_NAMES` export in `agent-types.ts`: single owner of the no-sub-subagent policy
- Removed `filterActiveTools`, `resolveToolEntries`, and `EXCLUDED_TOOL_NAMES` from `agent-runner.ts`
- `agent-runner.ts` now delegates tool filtering via `resolveVisibleTools()` — no private policy knowledge

**Files created/modified:**
- `src/agent-types.ts` — added `EXCLUDED_TOOL_NAMES`, `resolveToolEntries` (private), `resolveVisibleTools` (exported)
- `src/agent-runner.ts` — removed `filterActiveTools`, `resolveToolEntries`, `EXCLUDED_TOOL_NAMES`; imports and calls `resolveVisibleTools`
- `test/agent-runner.test.ts` — updated mock to include `resolveVisibleTools` with identical logic
- `test/agent-types-resolver.test.ts` — new: 29 unit tests for `resolveVisibleTools`

**Tests added:**
- 29 unit tests for `resolveVisibleTools` in `agent-types-resolver.test.ts` covering:
  - Allowlist mode (tools: string[])
  - Denylist mode (excludeTools, no tools whitelist)
  - tools: true / false / undefined
  - ext/* expansion (loaded, non-loaded, combined)
  - ext/tool syntax
  - Warning messages (unknown tool, extension with no matching tools, non-loaded extension)
  - EXCLUDED_TOOL_NAMES exclusion in all modes
  - Edge cases (empty activeTools, optional notify, optional extToolMap)

**Acceptance criteria:**
- [x] AC-1: `agent-types.ts` exposes `resolveVisibleTools` that resolves the visible tool set (allowlist/denylist/ext/*/exclude all in one place)
- [x] AC-2: `agent-runner.ts` no longer holds tool-name policy — delegates to resolver
- [x] AC-3: `BUILTIN_TOOL_NAMES` and `EXCLUDED_TOOL_NAMES` each have exactly one owner (both in `agent-types.ts`)
- [x] AC-4: `ext/*` expansion still works (extension tool maps built where session context is available, passed as `extToolMap` parameter)
- [x] AC-5: `filterActiveTools`'s existing behaviour is observable through the new resolver: `tools: true` → all (minus excluded), `string[]` → listed (minus excluded), `false` → none, plus denylist
- [x] AC-6: All 598 tests pass (569 original + 29 new)
- [x] AC-7: Typecheck passes

**Deviations (if any):**
- None

**Blockers (if any):**
- None

**Research needed (if any):**
- None
