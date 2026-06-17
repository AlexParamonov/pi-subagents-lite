# Slice Result: configurable-widget-stats

**Status:** COMPLETE

**What was built:**
- Fixed `setShowCost` (all 3 paths) to call `syncWidgetStatsVisibility()`
- Updated tests to assert `setStatsVisibility` is called on cost toggle

**Files created/modified:**
- `src/config/config-store.ts` — added `syncWidgetStatsVisibility()` to `setShowCost`, `session.setShowCost`, `session.clearShowCost`
- `test/config-store.test.ts` — added `setStatsVisibility` assertions to 3 setShowCost-related tests
- `review-1.md` — marked as RESOLVED with resolution notes

**Tests added:**
- 0 new tests, 3 existing tests updated with `setStatsVisibility` assertions

**Acceptance criteria:**
- [x] All 7 config keys exist with default `true`
- [x] Widget Settings menu shows 7 toggle items (ON/OFF)
- [x] Toggling a stat hides it from the stats line immediately
- [x] `showCost` (existing) is preserved and used as default for the new `showCost` key
- [x] Compactions (`↻`) are hidden when `showContext` is OFF
- [x] Stats line degrades gracefully (no double separators, no leading/trailing dots)
- [x] All existing tests pass
- [x] New tests cover filtering logic

**Deviations (if any):**
- Suggestion to update `renderer.ts` pattern acknowledged but not changed. Renderer serves a different display context (chat result cards) and doesn't use StatsVisibility. Different patterns for different contexts is appropriate.

**Blockers (if any):**
- None

**Research needed (if any):**
- None
