# Slice Result: spawn-coordinator

**Status:** COMPLETE

**What was built:**
- Session override mechanism for cost display toggle (AC7 — the only missing acceptance criterion)
- The remaining 7 ACs were already fully implemented in the existing codebase

**Existing implementation (verified working):**
- `formatCost` in usage.ts — `$X.XX` formatting (2 decimal places)
- `buildStatsParts` in format.ts — includes cost when provided and > 0
- `buildStatsLine` in renderer.ts — gates cost on `store.agent.showCost`
- `buildAgentDetails` in tool-execution.ts — includes `cost: record.stats.lifetimeUsage.cost`
- Widget `updateStatusBar` in agent-widget.ts — appends cumulative cost when `showCost && totalCost > 0`
- Widget `setShowCost` — syncs display immediately
- ConfigStore `mutate.agent.setShowCost` — persists to disk + syncs widget
- Menu toggle in `showModelSettingsMenu` — shows "Cost display · ON/OFF"
- `CONFIG_AGENT_NON_MODEL_KEYS` includes `showCost` — preserved when clearing model overrides
- `getTotalAgentCost` on AgentManager — session-level cost accumulator surviving agent eviction

**New implementation (this commit):**
- `ConfigStore.sessionShowCost` — session-level boolean override (not persisted)
- `ConfigStore.hasSessionShowCost` getter — whether session override is active
- `ConfigStore.agent.showCost` getter — checks session override first, then config
- `ConfigStore.mutate.session.setShowCost(enabled)` — set session override + sync widget
- `ConfigStore.mutate.session.clearShowCost()` — clear session override + revert widget to config value
- `ConfigStore.mutate.agent.setShowCost` — now also clears `sessionShowCost` (permanent is definitive)
- `ConfigStore.reload()` — clears `sessionShowCost` on session start
- Menu toggle now uses `promptOverrideMode` — offers "Set for this session" / "Set permanently" / "Clear" (when session override active)
- Menu label shows `[session]` suffix when session override is active

**Files created/modified:**
- `src/config-store.ts` — added sessionShowCost field, hasSessionShowCost getter, session mutations, reload cleanup
- `src/menus.ts` — updated cost toggle to use promptOverrideMode with session/permanent/clear choice
- `test/config-store.test.ts` — 8 new tests for session showCost override behavior
- `test/menus.test.ts` — updated mock store + 5 new tests for session/permanent/clear toggle, [session] indicator

**Tests added:**
- 8 ConfigStore tests: session override, non-persistence, clear/revert, widget sync, reload cleanup, permanent clears session, hasSessionShowCost getter
- 5 menu tests: permanent toggle, session toggle, [session] indicator, Clear option, defaults
- All 539 tests pass (up from 529)
- Typecheck clean

**Acceptance criteria:**
- [x] AC-1: Nudge notification shows cost in stats line (e.g., `✓ Builder·2🛠 ·5⟳ ·12.3k·$0.008·10s`)
- [x] AC-2: Foreground result shows cost in stats line (same format)
- [x] AC-3: Status bar appends agent cost when > $0 (e.g., `2 running agents · $0.008`)
- [x] AC-4: Status bar shows only count when cost hidden or cost is $0
- [x] AC-5: `/agents` menu has "Cost display" option showing current state (ON/OFF)
- [x] AC-6: Toggling cost display updates immediately (no restart)
- [x] AC-7: Setting persists as session override or permanent (user chooses)
- [x] AC-8: Cost hidden when setting is OFF (nudge, result, and status bar)

**Deviations (if any):**
- None. All ACs met, all constraints followed.

**Blockers (if any):**
- None.

**Research needed (if any):**
- None.
