Status: NEEDS_REVISION

# Review Summary

Files reviewed:
- `src/config-store.ts` (modified — sessionShowCost, hasSessionShowCost, session setShowCost/clearShowCost)
- `src/menus.ts` (modified — cost toggle uses promptOverrideMode for session/permanent/clear)
- `test/config-store.test.ts` (modified — 8 new tests for session showCost override)
- `test/menus.test.ts` (modified — 5 new/updated tests for session override behavior)

**Primary source of truth:** `tasks/standalone/spawn-coordinator/issue.md`

Issues found:
- 1 critical, 0 important, 0 suggestions

---

## Critical Mismatch: Issue Not Addressed

The task issue (`tasks/standalone/spawn-coordinator/issue.md`) describes creating a **SpawnCoordinator class** with SpawnIntent, LiveView, spawn(), Nudge ownership, onAgentComplete(), and migrations across tool-execution.ts, menus.ts, agent-widget.ts, and agent-manager.ts.

**None of this work exists.** `src/spawn-coordinator.ts` does not exist.

The actual work on this branch (commit `979f8f3`) is a **cost display session override** feature — adding session vs permanent persistence choice for the cost display toggle. This matches the buildtree's own `issue.md` (which describes cost display) but does **not** address the SpawnCoordinator task.

---

## What Was Reviewed: Cost Display Session Override (commit 979f8f3)

Since the code is present, I reviewed it for correctness against the buildtree's own issue.md.

### [CRITICAL] SpawnCoordinator Not Implemented

Confidence: 100/100
Location: `src/spawn-coordinator.ts` (file does not exist)
Problem: The primary issue (`tasks/standalone/spawn-coordinator/issue.md`) requires creating `src/spawn-coordinator.ts` with SpawnCoordinator class, LiveView type, SpawnIntent type, spawn() method, Nudge system, onAgentComplete(), and migrations. None of these acceptance criteria are met.
Why it matters: The entire SpawnCoordinator feature is unimplemented. The buildtree is working on a different feature (cost display toggle).
Fix: Implement the SpawnCoordinator as specified in the task issue, or clarify that this buildtree is intended for a different task.

---

## Quality Assessment of Cost Display Session Override

The cost display session override code is **correct and well-implemented**:

**Strengths:**
- Follows the established session override pattern (mirrors session model overrides)
- `agent.showCost` getter correctly checks session override first, then config: `this.sessionShowCost ?? (a.showCost === true)`
- `??` operator handles `false` correctly (only falls through on `undefined`)
- Permanent `setShowCost` clears session override (prevents stale state)
- `reload()` clears sessionShowCost (correct lifecycle behavior)
- `clearShowCost` reverts to config value directly (avoids circular read through getter)
- Menu reuses `promptOverrideMode` — consistent UX pattern
- 8 new ConfigStore tests + 5 menu tests cover all key scenarios
- Tests use in-memory ConfigIO and stubs — no module-level mocking

**Test quality:**
- Tests verify observable behavior (return values, state changes, widget sync calls)
- Tests are isolated (each creates fresh store with memIO)
- Good edge case coverage (reload clears session, permanent clears session, widget sync on clear)
- Menu tests verify label rendering, session indicator, and clear path

**No issues found in the cost display session override code itself.**

---

## Verdict

The code that exists is correct, but it does not address the stated issue. The SpawnCoordinator feature described in `tasks/standalone/spawn-coordinator/issue.md` is entirely unimplemented.
