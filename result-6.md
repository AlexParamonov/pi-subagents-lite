# Slice Result: fix-settings-cursor-position

**Status:** COMPLETE

**What was built:**
- `menu-widget-settings.ts`: Rewrote widget settings menu using `SettingsList` from `@earendil-works/pi-tui` via `ctx.ui.custom`. Single call per menu session. SettingsList maintains internal cursor state, fixing the bug where cursor reset to index 0 after each toggle.
- `menu-helpers.ts`: Added `buildSettingsListTheme(theme)` helper (builds `SettingsListTheme` from pi-coding-agent `Theme`) and `validateNumeric(value, min)` pure validation helper (extracted from `parseNumericInput`).
- Stat toggles grouped into a "Usage stats" submenu (nested `SettingsList`) for cleaner hierarchy.
- Numeric inputs use `submenu` Components wrapping pi-tui `Input` with `onSubmit`/`onEscape` callbacks.

**Files created/modified:**
- `src/ui/menu/menu-widget-settings.ts` — rewrote to use SettingsList + ctx.ui.custom
- `src/ui/menu/menu-helpers.ts` — added buildSettingsListTheme, validateNumeric
- `test/menu-widget-settings.test.ts` — rewrote tests (mock SettingsList/Input, test items + callbacks)
- `test/menus.test.ts` — updated 2 integration tests (Widget settings now uses ctx.ui.custom)
- `test/validate-numeric.test.ts` — new, 7 tests for validateNumeric
- `test/build-settings-list-theme.test.ts` — new, 8 tests for buildSettingsListTheme

**Tests added:**
- 7 unit tests for `validateNumeric` (boundary, non-numeric, whitespace, empty)
- 8 unit tests for `buildSettingsListTheme` (all properties, selected/unselected, cursor, hint)
- 22 tests for `showWidgetSettingsMenu` (SettingsList integration, toggles, numeric submenus, usage stats submenu, item order)
- 2 integration test updates in menus.test.ts

**Acceptance criteria:**
- [x] Toggling a setting (ON/OFF) keeps cursor at the same position — SettingsList maintains internal cursor state
- [x] Menu shows label on left, current value on right — SettingsList handles rendering via SettingItem.label/currentValue
- [x] Numeric inputs open input dialog via submenu Component, cursor returns to same position after — createNumericSubmenu wraps pi-tui Input
- [x] Back/Escape exits the menu — onCancel calls done()
- [x] Widget settings menu works correctly — all 22 tests pass
- [x] No visual regressions in menu appearance — same items, same order, same labels

**Deviations (if any):**
- None

**Blockers (if any):**
- None

**Research needed (if any):**
- None
