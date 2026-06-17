Status: APPROVED

# Review Summary

Files reviewed:
- `src/agent-runner.ts`
- `src/prompts.ts`
- `src/config-store.ts`
- `src/config-io.ts`
- `src/model-precedence.ts`
- `src/menus.ts`
- `src/types.ts`
- `test/agent-runner.test.ts`
- `test/config-store.test.ts`
- `test/menus.test.ts`
- `test/prompts.test.ts`

Prior review issues addressed:
- 4/4 important issues fixed
- 1/2 suggestions fixed ("Create prompt file" test coverage added)
- 1/2 suggestions deferred (union type alias — see below)

New issues found: 0

---

## Acceptance Criteria Verification

| Criterion | Status | Evidence |
|---|---|---|
| `systemPromptMode` added to `SubagentsConfig.agent` | ✅ | `model-precedence.ts:27`, `config-store.ts:47` |
| Default is `"replace"` | ✅ | `config-io.ts:22`, `config-store.ts:86` fallback |
| Settings menu shows mode + allows switching (permanent) | ✅ | `menus.ts:357-371`, `config-store.ts:188` mutation |
| `inherit` mode: `ctx.getSystemPrompt()` fetched at spawn | ✅ | `agent-runner.ts:549-555` |
| `custom` mode: reads `~/.pi/agent/subagents-lite-prompt.md` | ✅ | `agent-runner.ts:558-573` |
| Missing/empty custom file: fallback + notify | ✅ | `agent-runner.ts:567-572` (empty), `:569` (ENOENT) |
| Unreadable custom file: fallback + notify | ✅ | `agent-runner.ts:571` (other errors) |
| "Create prompt file" menu item when file absent | ✅ | `menus.ts:372-384` |
| Agent's systemPrompt always in `<agent_instructions>` | ✅ | `prompts.ts:99`, all three modes |
| `<active_agent>` after parent prompt in inherit mode | ✅ | `prompts.ts:110-112` |
| Tests cover all modes + fallback + empty/missing | ✅ | See test summary below |

## Test Coverage Summary

**prompts.test.ts** (unit — `buildAgentPrompt`):
- 3 modes (replace, inherit, custom) — output structure verified
- Fallback to replace when extras missing for inherit/custom
- `<agent_instructions>` wrapping in all modes
- Context files integration (ordering, escaping, empty/undefined)
- Skill metadata and blocks

**agent-runner.test.ts** (integration — `runAgent`):
- Replace mode passes `'replace'` to `buildAgentPrompt`
- Inherit mode calls `ctx.getSystemPrompt()`, passes result as `parentSystemPrompt`
- Inherit fallback: notify called, `parentSystemPrompt` absent from extras
- Custom mode: reads file via `fs.readFileSync`, passes as `customSystemPrompt`
- Custom fallback (ENOENT): notify + no `customSystemPrompt`
- Custom fallback (empty/whitespace): notify + no `customSystemPrompt`
- Custom fallback (other error): notify

**config-store.test.ts** (unit — `ConfigStore`):
- Default resolves to `"replace"`
- Configured value returned
- `setSystemPromptMode` persists + updates
- `clearAllModelOverrides` preserves `systemPromptMode`

**menus.test.ts** (integration — `showModelSettingsMenu`):
- "Create prompt file" shown when mode=custom + file absent
- Not shown when file exists
- Not shown when mode≠custom
- File creation action: `mkdirSync` + `writeFileSync` called
- Error notification on creation failure

---

## Prior Review Fixes Verified

1. **agent-runner mock parameterizable** (`test/agent-runner.test.ts:41,75`): `mockSystemPromptMode` is a hoisted variable, reset in `resetMocks()`, overridden per-test. All three mode paths now exercised.

2. **menus.ts mock complete** (`test/menus.test.ts:112,155,166`): `systemPromptMode` in agent getter, `setSystemPromptMode` in mutations, `systemPromptMode` preserved in `clearAllModelOverrides`.

3. **CUSTOM_PROMPT_PATH deduplicated** (`src/agent-runner.ts:31`, `src/menus.ts:25`): Exported from `agent-runner.ts`, imported in `menus.ts`. No circular dependency (menus → agent-runner only).

4. **ConfigStore validation** (`src/config-store.ts:84-86`): `validModes.has()` rejects invalid config values with `"replace"` fallback.

---

## Strengths

- **Thorough fallback handling**: Three distinct failure paths for custom mode (ENOENT, empty, other) each with appropriate notification messages. Inherit mode gracefully handles `getSystemPrompt()` exceptions.
- **KV cache optimization preserved**: Inherit mode correctly places `<active_agent>` after the verbatim parent prefix, maintaining byte-level cache coherence.
- **`<agent_instructions>` wrapping is consistent**: The agent's own systemPrompt is always wrapped identically regardless of mode — clean for downstream parsing.
- **Non-fatal error handling pattern**: All mode-specific failures fall back to replace behavior with `notify()` rather than crashing. The `notify()` helper is a clean abstraction.
- **Test quality**: Tests verify observable behavior (what gets passed to `buildAgentPrompt`), not internal implementation. Mocks are properly scoped and reset between tests.

---

## Remaining Suggestion (non-blocking, from prior review)

**Union type `"replace" | "inherit" | "custom"` repeated across 7 locations.**

Confidence: 75/100
Locations: `model-precedence.ts:27`, `config-store.ts:47,86,188`, `menus.ts:363`, `prompts.ts:46`, `agent-runner.ts:272`

The prior review suggested a shared `SystemPromptMode` type alias. Not addressed in this commit. Low risk since TypeScript catches mismatches at compile time, but worth a follow-up if a fourth mode is ever added.
