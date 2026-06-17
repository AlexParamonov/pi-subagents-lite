Status: NEEDS_REVISION

# Review Summary

Files reviewed:
- `src/agents/agent-types.ts`
- `src/agents/agent-runner.ts`
- `src/config/config-store.ts`
- `src/models/model-precedence.ts`
- `src/types.ts`
- `src/ui/menu/menu-system-prompt.ts`
- `test/agent-types-resolver.test.ts`
- `test/config-store.test.ts`
- `test/menu-mock-setup.ts`
- `test/menu-system-prompt.test.ts`

Issues found:
- 1 critical, 0 important, 0 suggestions

## [CRITICAL] `applyGlobalDefaults` cannot distinguish explicit `skills: true` from defaulted `true`

Confidence: 85/100
Location: `src/agents/agent-types.ts:289-299`

Problem:
The `applyGlobalDefaults` function overrides `skills: true` to `false` when `loadSkillsImplicitly === "none"`, but it cannot distinguish between:
1. Agent explicitly set `skills: true` in .md frontmatter (should ignore global default)
2. Agent didn't set skills, inherited `true` from `BASE_DEFAULTS` (should use global default)

Both cases produce `skills === true` by the time `applyGlobalDefaults` runs. The function treats all `true` values as "not explicitly set" and overrides them.

Trace for case 1 (explicit `skills: true` in .md):
- `parseExtensions(true)` → `true`
- `fromMd()` includes `skills: true` (not stripped by `compactDefined`)
- `mergeAgentOverrides()` → agent config has `skills: true`
- `applyGlobalDefaults(true, ..., "none", ...)` → `skills: false` ← **wrong**

Trace for case 2 (no skills in .md):
- `parseExtensions(undefined)` → `undefined`
- `compactDefined` strips it
- `mergeAgentOverrides()` → inherits `skills: true` from `BASE_DEFAULTS`
- `applyGlobalDefaults(true, ..., "none", ...)` → `skills: false` ← **correct**

Why it matters:
Violates the acceptance criteria: "Agent with explicit `skills: true`/`skills: false`/`skills: [...]` ignores the global default." The test at `test/agent-types-resolver.test.ts:396` codifies the incorrect behavior:
```typescript
it("agent with skills: true gets global loadSkillsImplicitly=none → false", () => {
    const result = getConfig("test-agent", "none", "load-all");
    expect(result.skills).toBe(false); // should be true per AC
});
```

Same issue applies to `extensions: true`.

Fix:
The `AgentConfig` type needs to distinguish "not set" from "explicitly true". Two options:

**Option A** (recommended): Make `skills` and `extensions` optional in `AgentConfig`:
```typescript
// types.ts
skills?: true | string[] | false;   // undefined = not set, use global default
extensions?: true | string[] | false;
```

Then change `BASE_DEFAULTS` in `agent-discovery.ts` to not set skills/extensions:
```typescript
const BASE_DEFAULTS: AgentConfig = {
  name: "unknown",
  description: "",
  // extensions and skills intentionally omitted — resolved by global default
  systemPrompt: "",
};
```

And update `applyGlobalDefaults`:
```typescript
function applyGlobalDefaults(
  skills: true | string[] | false | undefined,
  extensions: true | string[] | false | undefined,
  loadSkillsImplicitly: "load-all" | "none",
  loadExtensionsImplicitly: "load-all" | "none",
): { skills: true | string[] | false; extensions: true | string[] | false } {
  return {
    skills: skills === undefined ? (loadSkillsImplicitly === "none" ? false : true) : skills,
    extensions: extensions === undefined ? (loadExtensionsImplicitly === "none" ? false : true) : extensions,
  };
}
```

This requires updating downstream consumers of `config.skills` and `config.extensions` to handle `undefined` (which flows through to `false`/`true` via `applyGlobalDefaults`).

**Option B**: Track explicitness in a parallel field (e.g., `skillsExplicit?: true | string[] | false`). More invasive, less clean.

→ architecture-reviewer for the structural change to `AgentConfig.skills/extensions` optionality.
