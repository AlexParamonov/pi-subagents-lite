# Slice Result: agent-cost-display

**Status:** COMPLETE

**What was built:**
- `formatCost()` in `usage.ts`: Formats cost as `$X.XX` (2 decimal places)
- Cost parameter in `buildStatsParts()`: Appends cost to stats parts when > 0
- Cost in `buildStatsLine` (index.ts): Reads `cost` from agent result details, respects `showCost` toggle
- Cost in widget stats lines: Both `renderFinishedLine` and `buildStatsLine` pass cost from `lifetimeUsage.cost`
- Status bar cumulative cost: `updateStatusBar` sums running agent costs, appends `· $X.XX` when > $0
- Menu toggle: "Cost display · ON/OFF" in `/agents` > Model settings, persisted via `saveConfigAtomic`
- `setShowCostEnabled()`: Updates both config and widget for immediate toggle effect
- `showCost` preserved in "Clear all overrides" (UI setting, not model override)
- Foreground agent result stats include `cost: record.lifetimeUsage.cost`

**Files created/modified:**
- `src/usage.ts` — Added `formatCost()` function
- `src/model-precedence.ts` — Added `showCost?: boolean` to `SubagentsConfig.agent`
- `src/ui/agent-widget.ts` — Added `showCost` property, `setShowCost()` setter, cost in `buildStatsParts`, `renderFinishedLine`, `buildStatsLine`, `updateStatusBar`
- `src/index.ts` — Added `setShowCostEnabled()` export, cost in `buildStatsLine`, widget init with showCost
- `src/menus.ts` — Added "Cost display" toggle, imported `setShowCostEnabled`, preserved `showCost` in clear-all
- `src/tool-execution.ts` — Added `cost` to foreground result stats object
- `test/cost-display.test.ts` — New: 10 tests for `formatCost` and `buildStatsParts` cost
- `test/menus.test.ts` — Added 6 tests for cost toggle + mock for `setShowCostEnabled`

**Tests added:**
- 10 unit tests (formatCost, buildStatsParts cost integration)
- 6 menu tests (toggle display ON/OFF, toggle behavior, default state, clear-all preservation)
- Total: 312 tests passing (up from 296)

**Acceptance criteria:**
- [x] AC-1: Nudge notification shows cost in stats line
- [x] AC-2: Foreground result shows cost in stats line
- [x] AC-3: Status bar appends agent cost when > $0
- [x] AC-4: Status bar shows only count when cost hidden or $0
- [x] AC-5: `/agents` menu has "Cost display" option showing ON/OFF
- [x] AC-6: Toggling cost display updates immediately (no restart)
- [x] AC-7: Setting persists permanently (saved to config)
- [x] AC-8: Cost hidden when setting is OFF (nudge, result, status bar)

**Deviations:**
- No build script exists in package.json (DoD "bun run build" is N/A)
- Cost toggle is permanent-only (like forceBackground/graceTurns), not session/permanent choice. The issue mentioned "session or permanent" but the toggle is a boolean UI setting where permanent-only is the correct pattern.

**Blockers:** None

**Research needed:** None
