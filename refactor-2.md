# Refactoring Report — Widget Settings Implementation

**Status:** REFACTORED

## Challenge Phase

Reviewed: `src/menus.ts`, `src/ui/agent-widget.ts`, `test/menus.test.ts`

### YAGNI — does anything solve problems that don't exist?

- **`isCompactMode()`** — dead code. Never called from production or test code. The actual compact mode toggle flows through `syncCompactFromToolsExpanded()` → `setCompactMode()`. ✗
- **`toggleCompactMode()`** — dead code. Same situation. ✗
- **`selectByName` helper in tests** — dead code. Defined in commit `5c07ad2` but tests use string matching instead. ✗
- **`noopTheme` in tests** — dead code. Leftover from a prior refactoring of `createMockCtx`. ✗
- **`matchMenuChoice`** — no. Used by `showAgentsMainMenu` and `showDebugMenu`. ✓
- **`buildPreservedAgentConfig` + `CONFIG_AGENT_NON_MODEL_KEYS`** — no. Centralizes "what to preserve on clear" logic, preventing a class of bugs. ✓
- **`runMenuLoop`** — no. Clean abstraction shared by 4 menu builders. ✓

### KISS — is this the simplest thing that could work?

- **Widget settings menu**: Four items, each follows the same `read config → push label → push action` pattern. Compact mode and shortcut toggle are structurally similar but have a real behavioral difference (compact mode calls `syncWidgetSettings()`, shortcut doesn't). No false DRY extraction.
- **`parseNumericInput`**: Extracted from the old `parseConcurrencyInput`, reused by grace turns and widget max lines. Clean generalization.
- **`showWidgetSettingsMenu` vs `showModelSettingsMenu`**: Different concerns, different menus. Correct separation.

### DRY — is repetition actually duplication?

- **Widget toggle patterns**: Compact mode and shortcut toggle share structure but differ in sync behavior. Not true duplication.
- **`resetAgentState()` vs inline resets**: Different describe blocks need different reset scopes. Acceptable.

### Structure — is responsibility in the right place?

- Widget settings sync: Menu actions mutate config → `saveConfigAtomic` → `syncWidgetSettings`. Clean responsibility chain.
- `CONFIG_AGENT_NON_MODEL_KEYS`: Co-located with its only consumer (`buildPreservedAgentConfig`). Good.

## Changes Made

1. **Removed `toggleCompactMode()` and `isCompactMode()`** from `src/ui/agent-widget.ts` — dead public methods never called from production or test code.
2. **Removed `noopTheme` and `selectByName`** from `test/menus.test.ts` — dead test helpers defined but never referenced.

## What Was NOT Changed (and Why)

- `showWidgetSettingsMenu`: Clean, consistent with other menus, correctly handles sync behavior differences.
- `matchMenuChoice`: Good abstraction, well-used, replaces if-else chains.
- `buildPreservedAgentConfig` / `CONFIG_AGENT_NON_MODEL_KEYS`: Valuable DRY extraction.
- `parseNumericInput`: Clean generalization of numeric input validation.
- Test organization: Well-structured describe blocks by feature area.

## Commits

- `1b63eec` — refactor: remove dead code from agent-widget and menus tests

## Note

Pre-existing uncommitted changes to `src/index.ts` (adding `lastToolsExpanded` tracking to `syncCompactFromToolsExpanded`) cause a test failure in `test/index.test.ts > syncCompactFromToolsExpanded > syncs compact mode when widgetShortcut is true`. This is unrelated to the widget settings refactoring and should be addressed separately.
