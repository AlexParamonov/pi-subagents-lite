# Lessons Learned

## Common Patterns

### Worktrees
- Clean up after merge — commit or discard untracked files first. Verify path exists before spawning reviewers post-cleanup.
- Slice worktrees branch from feature branch HEAD, not main. Wave 2+ needs Wave 1 cleanup first.
- Feature worktree per feature, slice worktrees from latest HEAD.

### Testing
- ALWAYS run `bun run test` after merging to main — clean merge doesn't mean passing tests.
- Acceptance tests match planned interface (plan.md), not guessed implementation.
- When AC review returns NEEDS_REVISION on recently fixed code, re-review fresh.
- User manual testing result ("all works") → record and proceed, don't insist on automated loop.
- Test public interfaces. Test behaviour, not implementation details.
- Test the function contract (empty for unknown, wrapped for known), not hardcoded data strings.

### Delegation
- Delegate immediately without pre-reading files — agent explores itself.
- For simple tasks, propose 2-3 name/design alternatives upfront instead of iterating.
- Wave-level arch review catches incomplete feature branches — valuable checkpoint.
- Parallel sub-agents writing design docs: mandate distinct output paths per agent. Gitignored task dirs leave no history.

### Parallel Execution
- Parallel slice execution (2+ slices simultaneously) consistently saves time.

### Verification
- When merge agent reports success, verify the actual merge commit exists.
- Don't assume — verify. Code review catches silent production bugs (e.g., porcelain format mismatches).
- A trailing `?? N` fallback on `DEFAULT_CONFIG.agent.X` looks dead (the literal always has the value) but is forced by the optional-field type — `SubagentsConfig.agent` marks these `?`, so the static type is `T | undefined`. Run typecheck before removing "redundant" fallbacks.

### Agent Type Enforcement
- NEVER use `general-purpose` when workflow specifies a specialized agent type.
- Check workflow documentation for exact `agent` field values before spawning.
- `build_issue` workflow requires: builder, code-reviewer, refactor, manual-tester.

## Task-Specific Lessons

### split-menus-into-concern-modules
Splitting tests: explicitly enumerate expected test files in builder prompt. Cross-check module count vs test file count before marking complete. Builder skipped `menu-debug.test.ts` since its tests lived in dispatcher's test file.

### skills-extensions-default-config
When adding config overrides that must respect "explicit vs default" distinction, make source fields optional from the start. Type system enforces precedence contract, not runtime equality checks. Prefer booleans for toggle settings — string enums add complexity without clarity.

### configurable-widget-stats
When adding new visibility/config alongside existing similar config, trace ALL existing mutation paths for the old config. The old `showCost` had session override support — new visibility sync must cover the same paths.

### add-widget-desc-length-setting
Check if any WIP branches might land before merge — gives builder context for conflict resolution upfront.

### migrate-more-menus-to-settingslist
Dispatcher menus that route to submenus: use `ctx.ui.select` with `while(true)` loop. SettingsList is only for menus where cursor persistence matters (actual settings, not dispatchers). SettingsList + async `ctx.ui.select` submenus don't mix — causes escape-from-submenu-to-close-parent bug. Verify test names match what they actually test. The `undefined as any` pattern in submenu callbacks is unavoidable with current library API — document once, don't fight it.

### fix-settings-cursor-position
SettingsList supports toggles (`values[]`), submenus (`submenu` Component), static display. Does NOT support: multi-step dialogs, action buttons, section separators, dynamic item sets. Design submenu-Component layer before touching complex menus. Never call `ctx.ui.input`/`ctx.ui.select`/`ctx.ui.custom` from within active SettingsList (lose focus/cursor). Numeric inputs must be `submenu` Components wrapping pi-tui `Input`. When migrating to a new abstraction, verify it fits ALL in-scope menus before committing. Include concrete interface signatures when referencing external library APIs. Verify worktree freshness before spawning builder.

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
Module-level singletons still require `vi.mock()`. True reduction needs closure/factory pattern. Accept module singleton as sufficient if composition root goal is otherwise achieved.

### Builder verification
Verify builder reads issue.md and plan spec before implementing. Integration gaps between coordinator and widget are high-risk — test data flow end-to-end.

## unify-menus-to-pi-style - 2026-06-18
**What worked:** Proxy pattern (createDelegatingComponent) cleanly chains submenus (SelectList → Input) when SettingsList's single-Component submenu isn't enough. Shared submenu components (createModelSelectSubmenu, createNumericInputSubmenu, createConfirmSubmenu) earned their keep with 2-3 uses each. Builder caught and fixed critical submenu-discarding bugs in concurrency menus.
**What failed:** Initial builder created Input submenus that called subDone() immediately, discarding the Input before rendering. Tests masked this by calling captured mock handlers directly (unreachable in production). Code review caught all 3 instances.
**Next time:** When submenu callbacks chain multiple Components (e.g., SelectList → Input), verify the returned Component is renderable, not immediately closed. Tests must interact through the component tree, not captured mock references. The proxy/delegating-component pattern is the safe approach for multi-step submenus.
### fix-notify-session-tree-corruption - 2026-06-19
**What worked:** Buffer-then-flush pattern is the simplest fix for session tree corruption. No API changes, no new abstractions. Tests verified temporal ordering (no notify before turn loop completes).
**What failed:** Initial review caught that warnings would be silently lost if runTurnLoop throws. Builder addressed dead code in tests but missed the try/finally concern on first pass — review R2 approved after cleanup.
**Next time:** When deferring side effects, always consider error paths. try/finally guarantees flush even on exceptions.

### stream-thinking-to-output - 2026-06-21
**What worked:** Single config knob (`outputThinkingBufferSize`) keeps API clean. Buffer-then-flush pattern with deduplication via `thinkingBlockInProgress` flag handles both normal and missing `thinking_end` paths. Review loop caught real bugs (buffer clear without flush, flawed test assertions).
**What failed:** Builder committed to main instead of worktree branch (my fault for not checking worktree state before spawning). Had to cherry-pick commits and reset main. Nudge notifications stopped working in session after git state corruption — unclear root cause, harness restart fixed it.
**Next time:** Always verify worktree branch exists and is checked out before spawning builder. If nudges stop working mid-session, restart harness rather than debugging live state corruption.

### fix-nudge-stale-pi - 2026-06-22
**What worked:** Focused single-file fix. Stored `pi` reference on `SpawnCoordinator`, refreshed on each `spawn()` call, used in `emitIndividualNudge()` instead of stale `getPiInstance()` singleton. Review and refactor passed quickly.
**What failed:** Nothing significant. Clean single-pass implementation.
**Next time:** The `ExtensionAPI` (`pi`) reference becomes stale silently after session lifecycle events (compaction, model changes, internal reloads) within ~15-20 minutes. Never cache `pi` in module-level singletons. Always obtain a fresh reference — either via getter or by threading through the call chain from the most recent SDK callback. The SDK docs are explicit: `pi` is session-bound and must be used fresh.

### fix-stale-pi-context - 2026-06-21
**What worked:** Fast, focused fix. Removed pi caching entirely, resolved at call time via `getPiInstance()`. Defense-in-depth try-catch as safety net. 822 tests pass.
**What failed:** Nothing significant. Clean single-pass implementation.
**Next time:** Never cache `ExtensionAPI` or `ExtensionContext` instances. Session replacement/reload invalidates them. Always resolve fresh at call time (e.g., `getPiInstance()` from shell). Add try-catch around sendMessage for defense-in-depth. The pi reference becomes stale silently — no signal, just a throw on next use.

### thinking-buffer-setting - 2026-06-21
**What worked:** Simple ring toggle added cleanly to widget settings. Followed existing `setGraceTurns` mutation pattern. Builder nailed it on first pass — no issues.
**What failed:** `worktree_path` validation timed out on first two builder spawns. Workaround: spawned without it (prompt had absolute paths). Third spawn with it succeeded — likely transient.
**Next time:** When `worktree_path` validation fails, spawn without it. The prompt already tells the agent where to work. Don't retry the same failed call.
