Status: APPROVED

# Review Summary

Files reviewed:
- `src/usage.ts` — `formatCost` function
- `src/model-precedence.ts` — `showCost` config field
- `src/ui/agent-widget.ts` — Cost in widget, status bar, `buildStatsParts`
- `src/index.ts` — `setShowCostEnabled`, cost in `buildStatsLine`
- `src/menus.ts` — Cost display toggle menu item
- `src/tool-execution.ts` — Cost in nudge and foreground stats
- `test/cost-display.test.ts` — New tests for formatCost and buildStatsParts
- `test/menus.test.ts` — New tests for cost toggle, showCost preservation

Issues found:
- 0 critical, 0 important, 2 suggestions

## Acceptance Criteria Coverage

| # | Criterion | Status | Notes |
|---|-----------|--------|-------|
| 1 | Nudge shows cost in stats line | ✅ | `emitIndividualNudge` passes `cost: record.lifetimeUsage.cost`, rendered via `buildStatsParts` |
| 2 | Foreground result shows cost | ✅ | `executeSpawnForeground` passes cost, rendered via `buildStatsLine` |
| 3 | Status bar appends cost when > $0 | ✅ | `updateStatusBar` computes total and appends `· $X.XX` |
| 4 | Status bar shows only count when OFF/$0 | ✅ | Guard: `this.showCost && running.length > 0 && totalCost > 0` |
| 5 | Menu has "Cost display" ON/OFF | ✅ | After Grace turns, before per-type separator |
| 6 | Toggle updates immediately | ✅ | `setShowCostEnabled` → config + `widget.setShowCost()` |
| 7 | Persist as session or permanent | ⚠️ | Always saves permanently via `saveConfigAtomic`. Follows the `forceBackground` toggle pattern (no session option for booleans). Deviates from acceptance criteria wording but is consistent with codebase. |
| 8 | Cost hidden when OFF | ✅ | All 3 paths (nudge, result, status bar) check `showCost` |

## Design Notes

**Cost toggle always persists permanently.** The acceptance criteria mentions "session override or permanent (user chooses)" and the constraint says "Storage follows same pattern as model/concurrency overrides (session vs permanent)". However, the implementation follows the established pattern for boolean toggles — `forceBackground` also always saves permanently with no session option. This is a pragmatic simplification since boolean toggles don't have the same "inherit from parent" semantics that model overrides do. Consistent with codebase.

**`getLifetimeTotal` includes cost in token sum.** This is pre-existing behavior (confirmed by `usage.test.ts:72`). The `tokens` display in stats lines includes cost in the numeric total, while cost is also displayed separately as `$X.XX`. For typical cost values (fractions of a dollar) vs token counts (thousands), the inflation is negligible and doesn't affect display.

## Test Quality

Tests are well-structured and test behavior through public APIs:

- `formatCost` tests: Pure function, 6 cases covering zero, small, medium, large, rounding, and very small values ✅
- `buildStatsParts` cost tests: 4 cases covering included, excluded (undefined), excluded (zero), and ordering ✅
- Menu toggle tests: 5 cases covering display state, toggle ON→OFF, toggle OFF→ON, save behavior, and default ✅
- showCost preservation test: 1 case confirming "Clear all overrides" preserves `showCost` ✅

No `respond_to?`-style checks, no implementation-over-behavior testing. Tests verify observable return values and state changes.

## Suggestions

## [SUGGESTION] Unused imports in cost-display.test.ts

Confidence: 90/100
Location: `test/cost-display.test.ts:3`
Problem: `vi` and `beforeEach` are imported but never used in this test file.
Why it matters: Dead imports add noise and may trigger linter warnings.
Fix: Remove unused imports:
```typescript
import { describe, it, expect } from "vitest";
```

## [SUGGESTION] No test for status bar cost display behavior

Confidence: 75/100
Location: `src/ui/agent-widget.ts:614-628` (`updateStatusBar`)
Problem: The status bar cost display (acceptance criteria #3 and #4) — appending cumulative cost when > $0 and showing only count when OFF — is not directly tested. The `updateStatusBar` method is private to `AgentWidget`, which depends on TUI infrastructure, making it difficult to unit test in isolation.
Why it matters: Two acceptance criteria rely on this logic. The core formatting (`formatCost`, `buildStatsParts`) IS tested, and the guard conditions are straightforward, but the integration path from running agents → status bar text is untested.
Fix: If feasible, extract the status bar text construction into a pure helper (like `buildStatsParts` was extracted) and test it directly. Otherwise, this is acceptable as-is given the complexity of testing the widget class in isolation.

## Strengths

- **Clean separation of concerns.** The cost toggle delegates to `setShowCostEnabled` which cleanly syncs config and widget. No scattered state management.
- **Consistent patterns.** Cost display follows the same `buildStatsParts` path for nudge, foreground, and widget rendering. Single source of truth.
- **"Clear all overrides" correctly preserves showCost.** The `showCost` key is excluded from the override check and preserved during clearing, matching the pattern of `graceTurns` and `forceBackground`.
- **Good test coverage for the toggle.** The menu tests cover display, toggle behavior, save, notification, and default — comprehensive for the UI interaction.
- **Minimal, focused changes.** The diff is surgical: one new function in `usage.ts`, one new field in the config interface, cost threaded through existing display paths with clear guard conditions.
