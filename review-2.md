Status: APPROVED

# Review Summary

Files reviewed:
- `src/types.ts`
- `src/agents/agent-types.ts`
- `src/agents/agent-discovery.ts`
- `src/agents/default-agents.ts`
- `src/agents/agent-runner.ts`
- `src/models/model-precedence.ts`
- `src/config/config-store.ts`
- `src/ui/menu/menu-system-prompt.ts`
- `src/ui/format.ts`
- `test/agent-types-resolver.test.ts`
- `test/config-store.test.ts`
- `test/menu-system-prompt.test.ts`
- `test/menu-mock-setup.ts`

Issues found:
- 0 critical, 0 important, 0 suggestions

## Review Notes

This review covers the revision after arch-review-1 identified a BLOCK: `AgentConfig.skills/extensions` were required fields typed `true | string[] | false`, making it impossible to distinguish "explicitly set `true`" from "inherited default `true`". The fix has been applied correctly.

### Acceptance Criteria Verification

All 10 acceptance criteria are met:

1. **`loadSkillsImplicitly` accepts `"load-all"` | `"none"`, defaults `"load-all"`** — `ResolvedAgentSettings` in `config-store.ts:57`, `getConfig` parameter default in `agent-types.ts:309`, `config-store.ts:111` (`?? "load-all"`).

2. **`loadExtensionsImplicitly` accepts `"load-all"` | `"none"`, defaults `"load-all"`** — same pattern.

3. **Agent with no explicit skills/extensions uses global default** — `BASE_DEFAULTS` and both `DEFAULT_AGENTS` entries omit `skills`/`extensions`, leaving them `undefined`. `applyGlobalDefaults` resolves `undefined` from the global setting. Tests at `agent-types-resolver.test.ts:400-410` cover this.

4. **Agent with explicit `skills: true` ignores global default** — `applyGlobalDefaults` only overrides `undefined`, not `true`. Test at `agent-types-resolver.test.ts:396-398` confirms `skills: true` passes through under `"none"`.

5. **Agent with explicit `extensions: true` ignores global default** — test at `agent-types-resolver.test.ts:401-403`.

6. **System Prompt menu shows "Load skills implicitly · ON/OFF"** — `menu-system-prompt.ts:57-64`, tests at `menu-system-prompt.test.ts:117-134`.

7. **System Prompt menu shows "Load extensions implicitly · ON/OFF"** — `menu-system-prompt.ts:66-73`, tests at `menu-system-prompt.test.ts:141-158`.

8. **Clicking toggles between ON and OFF** — tests at `menu-system-prompt.test.ts:136-154` (skills) and `menu-system-prompt.test.ts:160-178` (extensions).

9. **Config persists in `~/.pi/agent/subagents-lite.json`** — `config-store.ts:227-234` calls `this.persist()`. Tests at `config-store.test.ts:507-514` and `config-store.test.ts:548-555` verify save behavior.

10. **Backward compatible** — `loadSkillsImplicitly`/`loadExtensionsImplicitly` default to `"load-all"`, preserving current behavior. Embedded agents that previously hardcoded `skills: true, extensions: true` now omit them, but under `"load-all"` (default) they resolve identically to `true`.

### Structural Fix Verification

The arch-review-1 BLOCK fix is correct and clean:

- `AgentConfig.skills` and `AgentConfig.extensions` are now optional (`types.ts:59,56`).
- `BASE_DEFAULTS` (`agent-discovery.ts:419-421`) and both `DEFAULT_AGENTS` entries (`default-agents.ts:17-24, 29-41`) omit both fields.
- `applyGlobalDefaults` (`agent-types.ts:289-299`) resolves `undefined` from the global setting; concrete values pass through.
- `toResolved` (`agent-types.ts:277`) returns the narrower optional type; `getConfig` (`agent-types.ts:317-319`) merges the resolved defaults before returning `ResolvedAgentConfig`.
- `ResolvedAgentConfig.skills` and `ResolvedAgentConfig.extensions` remain required (`agent-types.ts:272-273`), so downstream consumers never see `undefined`.

### Test Quality

Tests are well-structured:
- `agent-types-resolver.test.ts` — 9 cases covering explicit values, implicit defaults, mixed, and unknown agent types. Tests verify behavior at the public API boundary.
- `config-store.test.ts` — 10 cases covering defaults, persistence, updates, and `clearAllModelOverrides` preservation.
- `menu-system-prompt.test.ts` — 8 cases covering display text and toggle behavior for both settings.
- `menu-mock-setup.ts` — correctly updated to include new fields in `clearAllModelOverrides` preservation list.

### Minor Note (not an issue)

`getDisplayName` in `ui/format.ts:110` calls `getConfig(type)` without store arguments. The new parameters default to `"load-all"`, which is correct since display name resolution doesn't depend on skills/extensions.
