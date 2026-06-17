# Lessons Learned

## Common Patterns

### Worktrees
- Clean up worktrees after merge — leave nothing behind. Ensure worktree is clean (commit or discard untracked files) before merge.
- Slice worktrees must branch from feature branch HEAD, not main.
- Wave 2+ worktrees need Wave 1 cleanup first (stale branches).
- Verify worktree path exists before spawning reviewers post-cleanup.

### Testing
- ALWAYS run `bun run test` after merging to main — don't assume clean merge means passing tests.
- Acceptance tests should match planned interface (plan.md), not guessed implementation.
- When AC review returns NEEDS_REVISION on recently fixed code, re-review fresh.
- User manual testing result ("all works") → record and proceed, don't insist on automated loop.

### Delegation
- Delegate immediately without pre-reading files — agent explores itself.
- For simple tasks, propose 2-3 name/design alternatives upfront instead of iterating.
- Wave-level arch review catches incomplete feature branches — valuable checkpoint.
- When spawning parallel sub-agents that each write a design doc, mandate a distinct output path per agent. Two agents writing to the same path silently clobber each other, and gitignored task dirs leave no history.

### Parallel Execution
- Parallel slice execution (2+ slices simultaneously) consistently saves time.
- Feature worktree per feature, slice worktrees from latest HEAD.

### Verification
- When merge agent reports success, verify the actual merge commit exists.
- Don't assume — verify. Code review catches silent production bugs (e.g., porcelain format mismatches).

### Agent Type Enforcement
- NEVER use `general-purpose` when workflow specifies a specialized agent type.
- Check workflow documentation for exact `agent` field values before spawning.
- `build_issue` workflow requires: builder, code-reviewer, refactor, manual-tester.

## Task-Specific Lessons

### Unifying code paths
Diff old paths before merging to ensure all side effects are preserved. Widget lifecycle (ensureTimer, setUICtx) must happen in both paths.

### Mock factory extraction
Only extract mock factories with ≥1 consumer in the current slice. Speculative extraction is waste.

### Closing seam leaks
Thread parameter through call chain. Keep composition root reads at the boundary. Leave other modules unchanged.

### Lifecycle extraction
Identify scattered state mutations, wrap in a class with phase methods (create, attach, finalize), wire manager to hold instance per record. Preserve flush ordering in `.finally`.

### Policy co-location
Move scattered decision logic to a single owner, update callers to delegate. Verify no dead imports left behind.

### Large module extraction
Identify the deep concept buried in a god module, extract with all co-located helpers, import shared utilities back. Allow circular dependency when constraints permit — ESM handles it.

### Mock count reduction
Module-level singletons still require `vi.mock()`. True reduction needs closure/factory pattern. Accept module singleton as sufficient if the composition root goal is otherwise achieved.

### Builder verification
Verify builder reads issue.md and plan spec before implementing. Integration gaps between coordinator and widget are high-risk — test data flow end-to-end.

## split-menus-into-concern-modules - 2026-06-17
**What worked:** Clean split into 7 modules with clear boundaries. Builder handled the full refactor in one pass. Refactor loop caught dead re-exports and empty test files.
**What failed:** Manual tester caught missing `menu-debug.test.ts` — acceptance criteria said "one test file per menu module" but the builder skipped the debug module's test file since its tests lived in the dispatcher's test file.
**Next time:** When splitting tests, explicitly enumerate expected test files in the builder prompt to prevent gaps. Cross-check module count vs test file count before marking complete.

## skills-extensions-default-config - 2026-06-17
**What worked:** Grill phase quickly converged on naming ("implicitly" > "when unset"). Architecture review caught the core design flaw (can't distinguish explicit `true` from defaulted `true`). Fix was scoped and clean.
**What failed:** Initial implementation couldn't distinguish explicit `skills: true` from `BASE_DEFAULTS` `true` — both collapsed to `true` in `applyGlobalDefaults`. Architecture review blocked, required making `AgentConfig.skills/extensions` optional.
**Next time:** When adding config overrides that must respect "explicit vs default" distinction, make the source fields optional from the start. The type system should enforce the precedence contract, not rely on runtime equality checks.

**Config value design:** Prefer booleans for toggle settings. String enums ("load-all" | "none") add complexity without clarity. Menu display (ON/OFF) is independent of config representation.

## fix-settings-cursor-position - 2026-06-17
**What worked:** Architecture review caught critical scope creep and constraint contradictions before implementation.
**What failed:** Initial issue tried to migrate all 5 settings menus in one go. `SettingsList` only fits simple toggle/numeric menus (Widget, System prompt, Spawn options). Model and Concurrency need submenu-Component layer design first.
**Next time:** When migrating to a new abstraction, verify the abstraction fits ALL in-scope menus before committing. Check for constraint contradictions ("keep parseNumericInput" vs "persistent ctx.ui.custom").

**SettingsList limitations:** Supports toggles (`values[]`), submenus (`submenu` Component), static display. Does NOT support: multi-step dialogs, action buttons, section separators, dynamic item sets. Design submenu-Component layer before touching complex menus.
**Constraint pattern:** Never call `ctx.ui.input`/`ctx.ui.select`/`ctx.ui.custom` from within active `SettingsList` (lose focus/cursor). Numeric inputs must be `submenu` Components wrapping pi-tui `Input`.

## configurable-widget-stats - 2026-06-17
**What worked:** Clean vertical slice. Builder handled 7 config keys, visibility interface, menu toggles, and tests in one pass. Refactor extracted helper for repeated mutate→persist→sync pattern.
**What failed:** Code reviewer caught missing `syncWidgetStatsVisibility()` in `setShowCost` — the original cost toggle only updated the old property, not the new stats visibility. Three paths needed fixing (permanent, session override, session clear).
**Next time:** When adding new visibility/config alongside existing similar config, trace ALL existing mutation paths for the old config. The old `showCost` had session override support — new visibility sync must cover the same paths.

## fix-settings-cursor-position - 2026-06-17
**What worked:** Clean issue spec with library API docs enabled single-builder implementation. Review caught dead code and weak tests early. Refactor inlined numeric submenu to fix stale closure capture.
**What failed:** Prior worktree had corrupted state; fresh worktree was needed.
**Next time:** When issue references external library API, include concrete interface signatures. Verify worktree freshness before spawning builder.

## add-widget-desc-length-setting - 2026-06-17
**What worked:** Settings placed next to related max-lines items in menu. Both widget and menu read directly from ConfigStore. Refactor extracted shared `truncateDesc` helper, eliminating 4 duplicate truncation sites.
**What failed:** Builder initially added setter methods on AgentWidget — reviewer caught it wasn't needed, but it matched existing pattern so was kept. Merge hit SettingsList migration conflicts but builder resolved cleanly.
**Next time:** Check if any WIP branches might land before merge — gives builder context for conflict resolution upfront.

## migrate-more-menus-to-settingslist - 2026-06-17
**What worked:** SettingsList from pi-tui solves the cursor persistence bug cleanly. The `values` array pattern for toggles and `submenu` pattern for input-based settings both work well. Existing `buildSettingsListTheme` and `validateNumeric` helpers reduced boilerplate. Test-first approach with builder agent caught issues early.
**What failed:** First code review flagged misleading test name for briefing integration test. The test checked structure but claimed to check content. Quick fix: renamed test to match actual behavior.
**Next time:** When migrating menus, verify test names match what they actually test. The `undefined as any` pattern in submenu callbacks is unavoidable with current library API - document it once, don't fight it.
