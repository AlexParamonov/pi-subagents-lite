# Slice Result: spawn-coordinator

**Status:** COMPLETE

**What was built:**
- `src/spawn-coordinator.ts`: SpawnCoordinator class with LiveView, SpawnIntent, spawn(), Nudge system, onAgentComplete()
- Unified spawn path for both LLM tool executor and menu wizard
- Nudge system (schedule/batch/emit with 200ms coalesce window) owned by coordinator
- AgentActivity shrunk to LiveView (only activeTools + responseText)

**Files created/modified:**
- `src/spawn-coordinator.ts` — NEW: SpawnCoordinator class (220 lines)
- `test/spawn-coordinator.test.ts` — NEW: 15 tests for coordinator
- `src/tool-execution.ts` — MODIFIED: removed duplicate spawn/nudge code, uses coordinator.spawn()
- `src/menus.ts` — MODIFIED: removed duplicate spawn code, uses coordinator.spawn()
- `src/state.ts` — MODIFIED: added coordinator holder (setCoordinator/getCoordinator)
- `src/index.ts` — MODIFIED: constructs and wires coordinator, delegates onComplete
- `src/agent-manager.ts` — MODIFIED: added setOnComplete() for deferred wiring
- `src/ui/agent-widget.ts` — MODIFIED: AgentActivity shrunk to LiveView, reads stats from record
- `test/agent-widget.test.ts` — MODIFIED: simplified AgentActivity usage
- `test/menus.test.ts` — MODIFIED: added getCoordinator mock, updated 3 spawn tests
- `test/nudge-status-message.test.ts` — MODIFIED: uses coordinator directly for nudge tests
- `test/worktree-tool-execution.test.ts` — MODIFIED: added getCoordinator mock

**Tests added:**
- 15 SpawnCoordinator tests (spawn foreground/background, nudge batching, live-view lifecycle, onAgentComplete, dispose)
- 3 menu tests updated for coordinator
- All 554 tests pass

**Acceptance criteria:**
- [x] AC-1a: Created SpawnCoordinator class with LiveView, SpawnIntent, spawn(), Nudge, onAgentComplete()
- [x] AC-1b: Migrated LLM tool path from tool-execution.ts to coordinator.spawn()
- [x] AC-1c: Migrated menu spawn path from menus.ts to coordinator.spawn()
- [x] AC-1d: Shrank AgentActivity to LiveView (activeTools + responseText only)
- [x] AC-1e: Deleted duplicated spawn/nudge/activity-tracking code from tool-execution.ts and menus.ts

**Deviations (if any):**
- None. All acceptance criteria met.

**Blockers (if any):**
- None.

**Research needed (if any):**
- None.

**Net impact:**
- 228 additions, 326 deletions (-98 lines net reduction)
- Single spawn path for both LLM tool and menu
- Stats (turnCount, toolUses, lifetimeUsage) now read from record, not duplicated in activity
- Nudge system centralized in coordinator
- All tests pass, typecheck clean
