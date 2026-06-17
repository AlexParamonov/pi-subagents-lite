Status: RESOLVED

# Review Summary

Files reviewed:
- `src/config/config-io.ts`
- `src/config/config-store.ts`
- `src/models/model-precedence.ts`
- `src/types.ts`
- `src/ui/agent-widget.ts`
- `src/ui/format.ts`
- `src/ui/menu/menu-widget-settings.ts`
- `test/agent-widget.test.ts`
- `test/config-store.test.ts`
- `test/menu-mock-setup.ts`
- `test/menu-widget-settings.test.ts`
- `test/widget-stats-filtering.test.ts`

Issues found:
- 1 critical, 1 suggestion

## [CRITICAL] `setShowCost` mutation does not sync statsVisibility — cost toggle is broken

**Resolved:** Added `this.syncWidgetStatsVisibility()` to `setShowCost` (agent path), `session.setShowCost`, and `session.clearShowCost`. Updated tests to assert `setStatsVisibility` is called on all three paths.

Confidence: 100/100
Location: `src/config/config-store.ts:211-216`

**Problem:** All six new `setShow*` mutations call `this.syncWidgetStatsVisibility()`, but the existing `setShowCost` does not. After this change, `renderFinishedLine` and `buildStatsLine` in AgentWidget read cost visibility from `this.statsVisibility.showCost` (via `buildStatsParts`), but `setShowCost` only calls the old `this.widget?.setShowCost(enabled)` path which updates `this.showCost` — a property now only used by `updateStatusBar`, not by the stats line.

When the user toggles "Show cost" in the Widget Settings menu:
1. `setShowCost(true)` is called
2. Config is updated and persisted
3. `widget.showCost` is set (affects status bar only)
4. `statsVisibility.showCost` is **never updated**
5. The cost stat remains hidden/visible as before the toggle

The same issue exists for `session.setShowCost` and `session.clearShowCost` (lines 355-363), though those paths aren't used from the widget settings menu.

**Why it matters:** Toggling "Show cost" in the Widget Settings menu appears to have no effect on the stats line. Users will think the feature is broken.

**Fix:** Add `this.syncWidgetStatsVisibility()` to `setShowCost`, `session.setShowCost`, and `session.clearShowCost`:

```ts
// agent mutate path (line 211)
setShowCost: (enabled: boolean): void => {
    this.config.agent.showCost = enabled;
    this.sessionShowCost = undefined;
    this.persist();
    this.widget?.setShowCost(enabled);
    this.syncWidgetStatsVisibility();  // ADD THIS
},

// session mutate path (line 355)
setShowCost: (enabled: boolean): void => {
    this.sessionShowCost = enabled;
    this.widget?.setShowCost(enabled);
    this.syncWidgetStatsVisibility();  // ADD THIS
},

// session clear path (line 361)
clearShowCost: (): void => {
    this.sessionShowCost = undefined;
    this.widget?.setShowCost(this.config.agent.showCost === true);
    this.syncWidgetStatsVisibility();  // ADD THIS
},
```

## [SUGGESTION] `renderer.ts` still uses old cost/duration patterns

**Acknowledged, not changed.** Renderer serves a different display context (chat result cards) and doesn't use StatsVisibility. Different patterns for different contexts is fine.

Confidence: 85/100
Location: `src/ui/renderer.ts:24-35`

`buildStatsLine` in renderer.ts manually gates cost with `showCost ? ... : undefined` and pushes `formatMs` after `buildStatsParts`, instead of using the new `durationMs` parameter. This works correctly since renderer serves a different display context (chat messages, not the widget), but the pattern divergence is worth noting.

Not blocking — the renderer has different visibility needs and doesn't need `StatsVisibility`.
