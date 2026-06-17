Status: APPROVED

# Review Summary

Files reviewed:
- `src/config/config-store.ts` (diff 47f93e1..79ba997)
- `test/config-store.test.ts` (diff 47f93e1..79ba997)

Issues found:
- 0 critical, 0 important, 0 suggestions

## Fix Verification

The critical issue from review-1 is resolved. Commit `79ba997` adds `this.syncWidgetStatsVisibility()` to all three `setShowCost` paths:

1. **Permanent config** (`config-store.ts:215`): `mutate.agent.setShowCost` now calls `syncWidgetStatsVisibility()` after persisting and calling `widget.setShowCost`. ✓
2. **Session override** (`config-store.ts:359`): `mutate.session.setShowCost` now calls `syncWidgetStatsVisibility()` after setting `sessionShowCost`. ✓
3. **Session clear** (`config-store.ts:365`): `mutate.session.clearShowCost` now calls `syncWidgetStatsVisibility()` after clearing `sessionShowCost`. ✓

The `agent` getter (`config-store.ts:114`) resolves `showCost` as `this.sessionShowCost ?? (a.showCost === true)`, so `syncWidgetStatsVisibility` correctly picks up whichever value is active when it reads `this.agent.showCost`.

## Tests

Four assertions added in `config-store.test.ts`, all verifying `setStatsVisibility` is called after each path. The `widgetStub` mock tracks calls to `setStatsVisibility` with serialized arguments, so these are behavior assertions, not existence checks.

Tests pass (738/738). Typecheck clean.
