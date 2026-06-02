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

Issues found:
- 0 critical, 0 important, 0 suggestions

## Acceptance Criteria Verification

All tests pass (341 tests, 17 files). Typecheck passes. No lint configured.

### [x] `/agents` menu has a new "Widget settings" section

`src/menus.ts:520` adds `"5. Widget settings — Configure widget display options"` to `showAgentsMainMenu`, and dispatches to `showWidgetSettingsMenu` at line 535.

### [x] Compact mode toggle switches between 1-line and multi-line agent display

`AgentWidget` has `compactMode` property with `setCompactMode()` / `toggleCompactMode()` / `isCompactMode()`. `buildRunningBlocks()` (agent-widget.ts:468–491) renders compact agents as single-line (no continuation lines, activity inlined) vs full multi-line with continuation lines. The `showWidgetSettingsMenu` (menus.ts:466–477) provides a toggle that flips `widgetCompact`, saves, and calls `syncWidgetSettings()`.

Tests verify both modes: compact renders 2 lines (heading + 1), full renders ≥3 lines (heading + header + activity continuation).

### [x] Max lines setting controls widget height (default 12 for full, 6 for compact)

- `DEFAULT_MAX_WIDGET_LINES = 12` (agent-widget.ts:21)
- `maxLinesCompact = Math.floor(12 / 2) = 6` (agent-widget.ts:270)
- Overflow logic uses `this.compactMode ? this.maxLinesCompact : this.maxLines` (agent-widget.ts:543)
- Menu shows "Max lines (full) · N" and "Max lines (compact) · N" with input prompts

Tests verify `setMaxLines(8)` caps output at 8 lines and `setMaxLinesCompact(3)` caps compact output at 3 lines.

### [x] Compact max lines defaults to half of full max lines but can be overridden

- Default derivation: `Math.floor(widgetMaxLines / 2)` (index.ts:79, menus.ts:488, agent-widget.ts:270)
- When full max lines is changed via menu and compact max lines hasn't been explicitly set, the default updates (menus.ts:487–489)
- Compact max lines has its own separate menu entry that can be explicitly overridden (menus.ts:496–505)
- `widgetMaxLinesCompact` is intentionally omitted from `DEFAULT_CONFIG` (config-io.ts:22) so it always derives from the full value

### [x] Ctrl+o (tool expansion) toggles compact mode automatically

Per the note in the prompt: the Ctrl+o shortcut is now tied to tool expansion (built-in), which syncs with compact mode. The separate shortcut config was removed.

Implementation: `tool_execution_start` handler (index.ts:354–359) reads `ctx.ui.getToolsExpanded()` and calls `syncCompactFromToolsExpanded(expanded)`, which syncs `widget.setCompactMode()` and persists to `__config.agent.widgetCompact`. Session start initializes compact mode to false (index.ts:371). The menu's compact toggle (menus.ts:466–477) also works independently.

### [x] Widget updates immediately when settings change via menu

All three menu actions (compact toggle, max lines full, max lines compact) call `syncWidgetSettings()` after saving config (menus.ts:474, 490, 503). `syncWidgetSettings()` (index.ts:74–81) propagates all settings to the widget instance immediately. The widget's periodic timer (`WIDGET_REFRESH_INTERVAL = 80ms`) re-renders on next tick.

### [x] Settings persist across sessions in `~/.pi/agent/subagents-lite.json`

- Config keys added to `SubagentsConfig` interface (model-precedence.ts:22–24)
- Defaults set in `DEFAULT_CONFIG` (config-io.ts:18–23)
- All menu mutations call `saveConfigAtomic(__config)` before `syncWidgetSettings()`
- `syncWidgetSettings()` reads from `__config` with fallbacks: `widgetMaxLines ?? 12`, `widgetMaxLinesCompact ?? Math.floor(...)` (index.ts:76–80)
- `CONFIG_AGENT_NON_MODEL_KEYS` array (menus.ts:37–47) ensures widget settings are preserved when "Clear all overrides" is used

### [x] Widget respects max lines limit and shows overflow indicator when exceeded

- `renderWidget` calculates `maxBodyLines` and `maxBody` (agent-widget.ts:543–544)
- `applyOverflow` (agent-widget.ts:569–605) prioritizes running > queued > finished, reserves 1 line for overflow summary
- Overflow indicator format: `"+N more (N running, N finished)"` (agent-widget.ts:596–601)

Test verifies 10 agents with maxLines=5 produces an overflow line containing "more".

## Strengths

- **Clean extraction**: Widget settings menu is a self-contained `showWidgetSettingsMenu()` function with no cross-cutting concerns.
- **DRY refactoring**: `parseNumericInput` generalizes numeric input with validation (replaces inline grace turns parsing). `CONFIG_AGENT_NON_MODEL_KEYS` + `buildPreservedAgentConfig` centralize the "what to preserve on clear" logic.
- **Config consistency**: `widgetMaxLinesCompact` is intentionally omitted from `DEFAULT_CONFIG` and always derived at runtime, avoiding stale defaults.
- **Test coverage**: 12 new widget settings menu tests + 5 new widget rendering tests + 1 preservation test cover all menu flows and widget behavior including edge cases (reject invalid values, show overflow indicator).
- **Immediate sync**: Every menu mutation follows the pattern `save → syncWidgetSettings → notify`, ensuring the widget never shows stale state.
