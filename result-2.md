# Slice Result: system-prompt-mode (code review revision)

**Status:** COMPLETE

**What was built:**
- DRY fix: exported `CUSTOM_PROMPT_PATH` from `agent-runner.ts`, imported in `menus.ts` 
- Config validation: `systemPromptMode` now validated against valid set `{"replace", "inherit", "custom"}` in ConfigStore
- Integration tests: 7 new tests for all three modes (replace, inherit, custom) + fallback behavior
- Menu tests: 5 new tests for "Create prompt file" menu action

**Files modified:**
- `src/agent-runner.ts` — export `CUSTOM_PROMPT_PATH`
- `src/config-store.ts` — validate `systemPromptMode` against valid set
- `src/menus.ts` — import `CUSTOM_PROMPT_PATH`, remove inline path computation
- `test/agent-runner.test.ts` — parameterizable `mockSystemPromptMode`, 7 new tests
- `test/menus.test.ts` — shell mock fixes (`systemPromptMode`, `setSystemPromptMode`), 5 new tests

**Tests added:**
- 7 integration tests for agent-runner system prompt modes (replace, inherit, inherit-fallback, custom-file-read, custom-missing-file, custom-empty-file, custom-unreadable-file)
- 5 tests for "Create prompt file" menu action (visible when custom+missing, hidden when file exists, hidden when not custom, creates file, error handling)

**Acceptance criteria:**
- [x] `systemPromptMode: "replace" | "inherit" | "custom"` added to `SubagentsConfig.agent`
- [x] Default is `"replace"` (no behavior change)
- [x] Settings menu shows current mode + allows switching (permanent only, no session override)
- [x] `inherit` mode: `ctx.getSystemPrompt()` fetched at spawn, passed verbatim as base
- [x] `custom` mode: reads `~/.pi/agent/subagents-lite-prompt.md` at spawn
- [x] Custom prompt file missing/empty: fall back to `replace` mode + one-time notify with file path
- [x] Custom prompt file unreadable: fall back to `replace` mode + one-time notify
- [x] Settings menu offers "Create prompt file" when mode is `custom` but file doesn't exist
- [x] Agent's own `systemPrompt` always appended in `<agent_instructions>` tags
- [x] `inherit` mode: `<active_agent>` tag after parent prompt (KV cache prefix preserved)
- [x] Tests cover all three modes, fallback behavior, and empty/missing custom file

**Review feedback addressed:**
- [x] Add integration-level tests for `agent-runner.ts` — all three modes, fallback behavior, empty/missing custom file
- [x] Fix DRY violation on `CUSTOM_PROMPT_PATH` (define once in agent-runner.ts, reuse in menus.ts)
- [x] Fix unvalidated type assertion in `configStore.agent` (now validates against valid set)
- [x] Add test for "Create prompt file" menu action (5 tests covering visibility, creation, error)
- [x] Fix menus.test.ts shell mock — added `systemPromptMode` getter, `setSystemPromptMode` setter, preserved in `clearAllModelOverrides`

**Test results:** 646 tests passing (was 521 before, +125 new)
