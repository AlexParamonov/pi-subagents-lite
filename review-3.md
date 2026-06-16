Status: NEEDS_REVISION

# Review Summary

Files reviewed:
- `src/spawn-coordinator.ts` (new — SpawnCoordinator class, LiveView, SpawnIntent, Nudge system)
- `src/tool-execution.ts` (modified — migrated to coordinator.spawn(), removed createActivityTracker, nudge code)
- `src/menus.ts` (modified — migrated to coordinator.spawn(), removed duplicate spawn logic)
- `src/ui/agent-widget.ts` (modified — AgentActivity type shrunk, stats read from record)
- `src/index.ts` (modified — constructs coordinator, wires onAgentComplete)
- `src/agent-manager.ts` (modified — added setOnComplete)
- `src/state.ts` (modified — added coordinator holder)
- `test/spawn-coordinator.test.ts` (new — 15 tests)
- `test/agent-widget.test.ts` (updated — AgentActivity type change)
- `test/menus.test.ts` (updated — coordinator mock)
- `test/nudge-status-message.test.ts` (updated — uses coordinator directly)
- `test/worktree-tool-execution.test.ts` (updated — coordinator mock)

**Primary source of truth:** `tasks/standalone/spawn-coordinator/issue.md`

Issues found:
- 1 critical, 0 important, 1 suggestion

---

## [CRITICAL] Widget doesn't read from coordinator's liveView — running agent activity display broken

Confidence: 100/100
Location: `src/ui/agent-widget.ts:385`, `src/spawn-coordinator.ts:138`, `src/index.ts:108`

**Problem:** The coordinator creates `LiveView` objects and stores them in its own `this.liveViews` map. The manager's callbacks (onToolActivity, onTextDelta) correctly update these LiveViews. However, the widget still reads from `agentActivity` (the shared `Map<string, AgentActivity>` from state.ts), which is **never populated** by the coordinator.

The widget's `renderWidget()` at line 385:
```typescript
const bg = this.agentActivity.get(a.id);
const activity = bg ? describeActivity(bg.activeTools, bg.responseText) : THINKING_TEXT;
```

Since `agentActivity` is empty, `bg` is always `undefined`, and the widget always shows "thinking…" for all running agents instead of the actual tool activity ("reading…", "running command…", "editing…") and streaming response text.

**Evidence:**
- `grep agentActivity\.set src/` returns **zero matches** — nothing writes to the map
- The coordinator's `liveView()` and `deleteLiveView()` public methods are only called in tests, never in production
- The old code had `createActivityTracker()` which wrote to `agentActivity.set(agentId, state)` — this was removed but not replaced

**Why it matters:** This is a visible regression. Users can no longer see what their running agents are doing in the widget. The widget renders, the stats line works (reads from record), but the activity continuation line always shows "thinking…" instead of actual tool activity.

**Fix:** The widget needs to read live activity from the coordinator instead of from `agentActivity`. Two approaches:

*Option A (minimal change):* Have the coordinator write to `agentActivity` in addition to its own `liveViews`:
```typescript
// In SpawnCoordinator.spawn():
const liveView: LiveView = { activeTools: new Map(), responseText: "" };
this.liveViews.set(agentId, liveView);
// Also write to the shared agentActivity map for widget compatibility
agentActivity.set(agentId, liveView);  // LiveView is structurally compatible with AgentActivity
```

*Option B (cleaner, matches the plan):* Update the widget to accept the coordinator and read from it:
```typescript
// In AgentWidget constructor or setDeps:
constructor(manager, agentActivity, private getLiveView?: (id: string) => LiveView | undefined) {}

// In buildRunningBlocks:
const bg = this.getLiveView?.(a.id) ?? this.agentActivity.get(a.id);
```

Option A is simpler and doesn't change the widget's constructor signature. Option B is architecturally cleaner per the issue's AC ("liveView from coordinator").

**Test gap:** The widget tests manually set `activity.set("a1", makeActivity("a1"))`, bypassing the coordinator entirely. They verify the widget CAN display activity data but don't verify it's actually provided in production. This created false confidence that the implementation was complete.

---

## [SUGGESTION] `AgentActivity` type is now identical to `LiveView` — consider unifying

Confidence: 80/100
Location: `src/ui/agent-widget.ts:81-84`, `src/spawn-coordinator.ts:23-26`

**Problem:** After the shrink, `AgentActivity` and `LiveView` have identical shapes:
```typescript
// agent-widget.ts
export interface AgentActivity {
  activeTools: Map<string, string>;
  responseText: string;
}

// spawn-coordinator.ts
export interface LiveView {
  activeTools: Map<string, string>;
  responseText: string;
}
```

**Why it matters:** Two identical types in different modules is confusing and violates DRY. Anyone reading the codebase needs to understand the relationship between them.

**Fix:** Replace `AgentActivity` with `LiveView` imported from `spawn-coordinator.ts`, or re-export `LiveView` as `AgentActivity` for backward compatibility. This could be addressed when fixing the critical issue above.

---

## Acceptance Criteria Verification

| AC | Status | Notes |
|---|---|---|
| `src/spawn-coordinator.ts` created with SpawnCoordinator class | ✅ | 242 lines, well-structured |
| `LiveView` type defined (activeTools, responseText only) | ✅ | |
| `SpawnIntent` type defined for unified spawn input | ✅ | |
| `spawn()` works for both foreground and background | ✅ | Coordinator awaits foreground, returns immediately for background |
| Live-view map managed by coordinator | ✅ | Coordinator creates, stores, and cleans up LiveViews |
| Nudge (schedule/batch/emit, 200ms timer) owned by coordinator | ✅ | Moved from tool-execution.ts |
| `onAgentComplete()` consolidates completion chain | ✅ | Wired in index.ts |
| LLM tool path migrated to `coordinator.spawn()` | ✅ | Removed executeSpawnForeground/Background/createActivityTracker |
| Menu spawn path migrated to `coordinator.spawn()` | ✅ | Removed duplicate tracking/widget/await/cleanup |
| Duplicated code deleted from menus.ts | ✅ | ~40 lines removed |
| `AgentActivity` shrunk to `LiveView` | ✅ | Removed toolUses, turnCount, maxTurns, lifetimeUsage, session |
| `agent-widget.ts` reads stats from record | ✅ | renderFinishedLine and buildStatsLine read from record.stats |
| `agent-widget.ts` reads liveView from coordinator | ❌ | Widget still reads from `agentActivity` map (empty) — see critical issue |
| All tests pass | ✅ | 554 tests pass |
| Typecheck clean | ✅ | |

---

## Strengths

- **Clean SpawnCoordinator design**: Single entry point for both spawn paths, clear ownership boundaries (D2/D3/D4/D6 decisions respected)
- **Nudge batching**: 200ms coalesce window correctly prevents rapid-fire notifications
- **Completion chain simplification**: `onAgentComplete` consolidates markFinished, live-view cleanup, and nudge scheduling
- **Net negative LOC**: 228 additions, 326 deletions (-98 lines) — good cleanup
- **Test migration**: Tests updated to use coordinator directly (nudge tests) or via mocks (menus, worktree tests)
- **`buildAgentDetails` preserved as pure function**: Correctly stayed in tool-execution.ts per constraint
- **`agentManager.setOnComplete()`**: Clean API for deferred wiring without constructor changes
