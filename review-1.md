Status: NEEDS_REVISION

# Review Summary

Files reviewed:
- `src/agent-types.ts`
- `src/agent-runner.ts`
- `test/agent-runner.test.ts`
- `test/agent-types-resolver.test.ts`

Issues found:
- 0 critical, 1 important, 1 suggestion

---

## [IMPORTANT] Dead import: `BUILTIN_TOOL_NAMES` still imported in agent-runner.ts

Confidence: 100/100
Location: `src/agent-runner.ts:20`

Problem: `BUILTIN_TOOL_NAMES` is imported but never referenced in the file. After moving the tool visibility policy to `agent-types.ts`, the only consumer of `BUILTIN_TOOL_NAMES` is in that module. The import in `agent-runner.ts` is dead code.

```ts
// Line 20 — BUILTIN_TOOL_NAMES is unused
import { getAgentConfig, getConfig, getToolNamesForType, BUILTIN_TOOL_NAMES, resolveVisibleTools } from "./agent-types.js";
```

Why it matters: Dead imports create noise and mislead readers about dependencies. If a linter with no-unused-vars is ever enabled, this will fail.

Fix:
```ts
import { getAgentConfig, getConfig, getToolNamesForType, resolveVisibleTools } from "./agent-types.js";
```

---

## [SUGGESTION] Misleading test name: "empty activeTools returns null" asserts `[]`

Confidence: 80/100
Location: `test/agent-types-resolver.test.ts:343`

Problem: The test is named `"empty activeTools returns null"` but the assertion is `expect(result).toEqual([])`. When `tools: ["read"]` (whitelist mode) with empty `activeTools`, the resolver enters the whitelist branch, builds `allowedTools = {"read"}`, iterates no active tools, and returns `[...visibleSet]` which is `[]` — not `null`. The test name contradicts the expected behavior.

```ts
it("empty activeTools returns null", () => {        // ← name says null
    const result = resolveVisibleTools({
      activeTools: [],
      tools: ["read"],
    });
    expect(result).toEqual([]);                      // ← asserts []
});
```

Fix: Rename to `"empty activeTools with whitelist returns []"`.
