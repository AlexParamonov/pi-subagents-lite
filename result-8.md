# Slice Result: migrate-more-menus-to-settingslist

**Status:** COMPLETE

**What was built:**
- `showAgentsMainMenu`: Migrated from `ctx.ui.select` + `matchMenuChoice` loop to `SettingsList` with 4 submenu items (Running agents, Spawn agent, Settings, Debug)
- `showSettingsMenu`: Migrated from `ctx.ui.select` + `matchMenuChoice` loop to `SettingsList` with 5 submenu items (Model, Concurrency, Spawn options, System prompt, Widget)
- `showSpawnOptionsMenu`: Migrated from `runMenuLoop` + `ctx.ui.select`/`ctx.ui.input` to `SettingsList` with `values` toggles and `Input` submenus for numeric fields
- `showSystemPromptMenu`: Migrated from `runMenuLoop` + `ctx.ui.select` to `SettingsList` with `values` toggles and conditional `createPromptFile` item

**Files created/modified:**
- `src/ui/menu/menus.ts` — rewrote showAgentsMainMenu and showSettingsMenu to use SettingsList
- `src/ui/menu/menu-spawn-options.ts` — rewrote showSpawnOptionsMenu to use SettingsList
- `src/ui/menu/menu-system-prompt.ts` — rewrote showSystemPromptMenu to use SettingsList
- `test/menus.test.ts` — rewrote tests for SettingsList integration
- `test/menu-spawn-options.test.ts` — rewrote tests for SettingsList integration
- `test/menu-system-prompt.test.ts` — rewrote tests for SettingsList integration

**Tests added:**
- 15 tests for main menu and settings menu SettingsList integration
- 23 tests for spawn options SettingsList integration
- 22 tests for system prompt SettingsList integration
- Total: 813 tests pass (up from 810 baseline)

**Acceptance criteria:**
- [x] Main menu: selecting any item opens its sub-menu, cursor returns to same position after
- [x] Settings menu: selecting any item opens its sub-menu, cursor returns to same position after
- [x] Spawn Options menu: toggling "Force background" keeps cursor at same position
- [x] Spawn Options menu: "Grace turns" opens input submenu, cursor returns after edit
- [x] Spawn Options menu: "Default max turns" accepts number or "unlimited"
- [x] Spawn Options menu: "Default thinking level" cycles through values
- [x] System Prompt menu: toggling any ON/OFF setting keeps cursor at same position
- [x] System Prompt menu: "System prompt mode" cycles through replace/inherit/custom
- [x] System Prompt menu: "Create prompt file" only appears when mode=custom AND file missing
- [x] All menus show label on left, current value on right
- [x] Back/Escape exits any menu level and returns to parent
- [x] No visual regressions in menu appearance
- [x] All existing tests pass
- [x] New tests for all migrated menus pass

**Deviations (if any):**
- "Create prompt file" implemented as a `values: ["Create"]` item instead of a submenu, since it's a one-shot action that doesn't need an Input component. The onChange handler creates the file and notifies.
- Main menu and Settings menu submenus (Running agents, Debug, Model settings, Concurrency settings) still use `ctx.ui.select` internally since they weren't migrated in this issue. The `submenu` callbacks call them via `.then(() => done())`.

**Blockers (if any):**
- None

**Research needed (if any):**
- None
