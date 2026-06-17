# Slice Result: fix-settings-cursor-position (review revision)

**Status:** COMPLETE

**What was built:**
- Data-driven stat toggle onChange: eliminated hardcoded 7-case switch, `buildStatToggleItems` now returns `StatToggleItem[]` with `set` closures, `onChange` does a single `find()` lookup
- Strengthened theme tests: exact `.toBe()` assertions on styled output replace weak `.toContain()`

**Files modified:**
- `src/ui/menu/menu-widget-settings.ts` — added `StatToggleItem` interface, changed `buildStatToggleItems` to carry `set` closures, replaced 7 stat cases in `onChange` with data-driven lookup
- `test/build-settings-list-theme.test.ts` — replaced 7 `.toContain` assertions with exact `.toBe` checks

**Tests added:** 0 new tests, 7 existing tests strengthened

**Acceptance criteria:**
- [x] Toggling a setting keeps cursor at the same position (existing, unchanged)
- [x] Menu shows label/value layout (existing, unchanged)
- [x] Numeric inputs open submenu dialog (existing, unchanged)
- [x] Back/Escape exits the menu (existing, unchanged)
- [x] Widget settings menu works correctly (existing, unchanged)
- [x] No visual regressions (existing, unchanged)

**Review items addressed:**
- [x] Dead `setter` field: removed duplication, stat toggles now drive onChange via their `set` closures
- [x] Weak theme tests: now verify exact styled output (`"**<accent>Test</accent>**"` not just `.toContain("Test")`)
