Status: APPROVED

# Review Summary

Files reviewed:
- `src/config-io.ts`
- `src/index.ts`
- `src/menus.ts`
- `src/model-precedence.ts`
- `src/ui/agent-widget.ts`
- `test/agent-widget.test.ts`
- `test/menus.test.ts`

Issues found: 0 critical, 0 important, 1 suggestion

## Acceptance Criteria Verification

### ✅ `/agents` menu has a new "Widget settings" section
**Verified in:** `src/menus.ts:360-410`

A `"─── widget settings ───"` separator is inserted between cost display and grace turns, with four items: Compact mode toggle, Max lines (full), Max lines (compact), and Ctrl+o shortcut. Menu ordering test at `test/menus.test.ts:1108-1122` confirms correct placement.

### ✅ Compact mode toggle switches between 1-line and multi-line agent display
**Verified in:** `src/ui/agent-widget.ts:468-496`

`buildRunningBlocks()` conditionally renders agents. In compact mode, the activity text is appended inline to the header line with `continuations: []` (single line). In full mode, the agent gets a header + continuation lines for output file and activity. Tests at `test/agent-widget.test.ts:410-427` verify both modes produce the expected line counts.

### ✅ Max lines setting controls widget height (default 12 for full, 6 for compact)
**Verified in:** `src/ui/agent-widget.ts:20`, `src/ui/agent-widget.ts:265-266`

`DEFAULT_MAX_WIDGET_LINES = 12`. Widget class defaults: `maxLines = 12`, `maxLinesCompact = Math.floor(12 / 2) = 6`. Overflow logic at `src/ui/agent-widget.ts:546` selects `this.compactMode ? this.maxLinesCompact : this.maxLines`. Tests at `test/agent-widget.test.ts:448-483` verify both modes respect their respective limits.

### ✅ Compact max lines defaults to half of full max lines but can be overridden
**Verified in:** `src/index.ts:78-79`, `src/ui/agent-widget.ts:266`, `src/menus.ts:393-394`

Three layers of defaulting:
1. Widget class: `maxLinesCompact = Math.floor(DEFAULT_MAX_WIDGET_LINES / 2)`
2. `syncWidgetSettings()`: `__config.agent.widgetMaxLinesCompact ?? Math.floor((__config.agent.widgetMaxLines ?? 12) / 2)`
3. Menu display: `__config.agent.widgetMaxLinesCompact ?? Math.floor(maxLines / 2)`

The dedicated "Max lines (compact)" menu item allows explicit override. The "Max lines (full)" handler cascades to compact only when compact hasn't been explicitly set (`if (__config.agent.widgetMaxLinesCompact === undefined)`).

### ✅ Ctrl+o shortcut toggles compact mode when enabled in config
**Verified in:** `src/index.ts:84-96`

`syncWidgetShortcut()` calls `piInstance.registerShortcut(Key.ctrl("o"), { handler: () => { widget?.toggleCompactMode(); ... } })`. The handler also syncs the new state back to `__config.agent.widgetCompact` for persistence. Called from `session_start` handler and from the menu toggle action.

### ✅ Ctrl+o shortcut does nothing when disabled in config (default)
**Verified in:** `src/config-io.ts:21`, `src/index.ts:97-102`

`DEFAULT_CONFIG` sets `widgetShortcut: false`. When disabled, `syncWidgetShortcut()` registers a no-op handler: `handler: () => {}`. This is a pragmatic approach since the `registerShortcut` API doesn't expose an `unregisterShortcut` method. The key is still consumed by the extension, preventing conflicts.

### ✅ Widget updates immediately when settings change via menu
**Verified in:** `src/menus.ts:374-377`, `src/menus.ts:387-389`, `src/menus.ts:399-401`, `src/menus.ts:410-412`

Every menu action calls `syncWidgetSettings()` (or `syncWidgetShortcut()`) after `saveConfigAtomic()`. `syncWidgetSettings()` directly mutates the widget's internal properties (`compactMode`, `maxLines`, `maxLinesCompact`). The widget's 80ms render timer picks up the changes on the next tick — imperceptible to the user.

### ✅ Settings persist across sessions in `~/.pi/agent/subagents-lite.json`
**Verified in:** `src/config-io.ts:17-25`, `src/model-precedence.ts:22-25`

All four widget config keys (`widgetMaxLines`, `widgetMaxLinesCompact`, `widgetCompact`, `widgetShortcut`) are:
- Declared in the `SubagentsConfig` interface with proper types
- Included in `DEFAULT_CONFIG` (with `widgetMaxLinesCompact` intentionally omitted to derive from `widgetMaxLines`)
- Written to disk via `saveConfigAtomic(__config)` in every menu action
- Preserved during "Clear all overrides" via `CONFIG_AGENT_NON_MODEL_KEYS` and `buildPreservedAgentConfig()`

### ✅ Widget respects max lines limit and shows overflow indicator when exceeded
**Verified in:** `src/ui/agent-widget.ts:546-562`, `src/ui/agent-widget.ts:590-629`

The `applyOverflow()` method reserves 1 line for the overflow indicator, prioritizes running > queued > finished blocks, and renders `"+N more (X running, Y finished)"` when blocks are hidden. Tests at `test/agent-widget.test.ts:473-483` verify overflow indicator presence.

---

## Strengths

1. **Clean separation of concerns** — Widget state is managed via setter methods; menu actions are the only mutation path; config I/O is atomic.
2. **Comprehensive test coverage** — 17 new widget settings tests in `test/menus.test.ts` covering display, toggle, input validation, and ordering. 4 new behavior tests in `test/agent-widget.test.ts` for compact mode rendering and max lines. Existing "clear all overrides" test extended to verify widget settings preservation.
3. **Refactored `parseNumericInput`** — Extracted reusable validation from the old `parseConcurrencyInput`, reducing duplication and making the grace turns validation consistent (also fixing its error message format).
4. **`CONFIG_AGENT_NON_MODEL_KEYS` centralization** — The list of preserved keys is defined once and used for both the `hasOverrides` check and the preserved-config construction, eliminating a class of bugs where new settings would be forgotten.
5. **Proper type declarations** — All widget config keys are typed in the `SubagentsConfig` interface with appropriate optionality markers.

---

## [SUGGESTION] `isCompactMode()` is dead code in production

Confidence: 90/100
Location: `src/ui/agent-widget.ts:302-304`
Problem: `isCompactMode()` is defined as a public method but never called anywhere in production or test code.
Why it matters: Minor code hygiene. A public API method that goes unused can confuse maintainers about whether external consumers depend on it.
Fix: Either add a test that uses it (e.g., verify state after `toggleCompactMode()`) or remove it if no external consumer needs it. Low priority.
