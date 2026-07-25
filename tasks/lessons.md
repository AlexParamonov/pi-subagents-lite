# Lessons Learned

## General

### Worktrees
- Clean up after merge: commit/discard untracked files first. Verify path exists before spawning reviewers.
- Slice worktrees from feature branch HEAD, not main. Wave 2+ needs Wave 1 cleanup first.
- Always verify worktree branch exists and is checked out before spawning builder.

### Testing
- Always `bun run test` after merging to main; clean merge ≠ passing tests.
- Acceptance tests match planned interface (plan.md), not guessed implementation.
- Test public interfaces and behaviour, not implementation details or hardcoded data.
- User manual testing result ("all works") → record and proceed, don't insist on automated loop.
- When AC review returns NEEDS_REVISION on recently fixed code, re-review fresh.

### Delegation
- Delegate immediately without pre-reading files — agent explores itself.
- For simple tasks, propose 2-3 name/design alternatives upfront.
- Wave-level arch review catches incomplete feature branches.
- Parallel sub-agents writing design docs: mandate distinct output paths per agent.
- Parallel slice execution (2+ slices) consistently saves time.

### Verification
- When merge agent reports success, verify the actual merge commit exists.
- Don't assume — verify. Code review catches silent production bugs.
- `ExtensionAPI` (pi) is rejecting calls to old ctx, add try-catch around sendMessage for defense-in-depth.
- A trailing `?? N` fallback on optional config fields looks dead but is forced by `T | undefined` static type. Run typecheck before removing "redundant" fallbacks.
- Never use `general-purpose` when workflow specifies a specialized agent type. Check workflow docs for exact `agent` values before spawning.

## Task-Specific

### unify-menus-to-pi-style
**Worked:** Proxy pattern (createDelegatingComponent) chains submenus cleanly. Shared submenu components (createModelSelectSubmenu, createNumericSubmenu, createConfirmSubmenu) earned keep with 2-3 uses each.
**Failed:** Builder created Input submenus calling subDone() immediately, discarding Input before rendering. Tests masked this by calling captured mock handlers directly.
**Next:** When submenu callbacks chain Components, verify returned Component is renderable, not immediately closed. Tests must interact through component tree, not captured mock references.

### fix-notify-session-tree-corruption
**Worked:** Buffer-then-flush pattern — simplest fix for session tree corruption. No API changes.
**Failed:** Initial review caught silent warning loss on runTurnLoop throw. Builder missed try/finally concern on first pass.
**Next:** When deferring side effects, always consider error paths. try/finally guarantees flush.

### stream-thinking-to-output
**Worked:** Single config knob (`outputThinkingBufferSize`). Buffer-then-flush with deduplication via `thinkingBlockInProgress` flag.
**Failed:** Builder committed to main instead of worktree branch. Had to cherry-pick and reset main. Nudge notifications broke after git state corruption.
**Next:** Verify worktree branch before spawning. If nudges stop working, restart harness rather than debugging live state.

### fix-settings-cursor-position
**Next:** SettingsList supports toggles, submenus, section separators (via `__sep__` items), and static display. Does NOT support: multi-step dialogs, action buttons, or dynamic item sets. Never call ctx.ui.input/select/custom from within active SettingsList. Design submenu-Component layer before touching complex menus.

### migrate-more-menus-to-settingslist
**Next:** Dispatcher menus → `ctx.ui.select` with `while(true)` loop. SettingsList only for cursor-persistence menus. SettingsList + async select submenus don't mix. Verify test names match what they test.

### Config & Refactoring Patterns
- When adding config overrides respecting "explicit vs default", make source fields optional from the start. Type system enforces precedence, not runtime equality checks.
- When adding new visibility/config alongside existing similar config, trace ALL existing mutation paths for the old config.
- Check if any WIP branches might land before merge — gives builder context for conflict resolution.
- Only extract mock factories with ≥1 consumer in the current slice. Speculative extraction is waste.
- Diff old paths before merging to ensure all side effects are preserved.
- Module-level singletons still require vi.mock(). Accept module singleton as sufficient if composition root goal is otherwise achieved.

### pi-ai API
- `deliverAs: "steer"` only queues while the parent agent is running. If the agent is idle when the message arrives, pi drops it silently.
- `deliverAs: "followUp"` waits for the agent to finish, then delivers. Use this for notifications that must arrive regardless of agent state.
- Check `ctx.isIdle()` at call time to pick the right delivery mode. Don't assume agent state from caller context.

### Subagent session lifecycle
- Subagents are built with `createAgentSession`, which runs its own `DefaultResourceLoader.reload()` and `session.bindExtensions()`. That re-executes EVERY extension factory and re-fires `session_start`/`session_shutdown` in the subagent's context, NOT just the parent's.
- An extension that writes parent-owned state in its factory or `session_start` handler (module-level shell singletons like `pi`/`ctx`) will have that state clobbered by every subagent spawn. The last subagent to load wins, so later reads (e.g. a completion nudge firing via `setTimeout`) route to a dead/wrong session. Failures are silent because the misrouted `sendMessage` swallows internally and does not throw.
- Fix: bracket the subagent entry point (`runAgent`) with a nesting-depth flag and make the factory + `session_start`/`session_shutdown` handlers a no-op while a subagent is in flight. Parent reload still refreshes the shell (flag is false outside `runAgent`). `dispose()` gates deferred work after `session_shutdown`.
- `AgentSession.dispose()` does NOT emit `session_shutdown` (only the interactive runtime's `teardownCurrent` does). So subagent cleanup won't dispose parent state, but subagent `bindExtensions` WILL fire the parent's `session_start` handler.

## import-thinking-level-from-pi-ai — 2025-07-17
**What worked:** Single meaningful behavior test in agent-types-discovery (frontmatter→config flow) beats multiple implementation tests on a one-liner.
**What failed:** Builder wrote implementation tests twice (array contents, exact count) before we caught it. Review loop caught it but cost two extra builder cycles.
**Next time:** Specify test location and approach in the issue or builder prompt. "Test frontmatter parsing of max" not "cover max in tests".

## package-name-extension-matching — 2025-07-17
**What worked:** Breaking `extensionPackageName` into memoizing wrapper + pure resolver clarified concerns. `.has()` presence check solved the negative caching bug cleanly.
**What failed:** First review caught critical `path.dirname(extPath)` bug and case-insensitive behavior mismatch. Second review found test structure issues (duplicated mock setup, testing via runAgent ceremony). Third review found node_modules test gap. Fourth review passed.
**Next time:** Export test-facing functions early to avoid mock ceremony. Test node_modules paths from the start — it's the primary real-world scenario. Use `.has()` for nullable caches, not value-guard patterns.

## agent-widget-navigation — 2025-07-17
**What worked:** Issue.md prototype code blocks (state machine, key handler) gave builder a clear contract. The `matchesKey`/`isKeyRelease` pattern from pi-tui avoided reinventing key parsing. `viewerOpen` flag cleanly separated overlay lifecycle from nav deactivation.
**What failed:** Builder wrote tests against a hand-copied handler instead of the real exported function. Overflow scrolling was described in the AC but not implemented. Focus detection used private pi-tui field instead of public `hasOverlay()` API.
**Next time:** Export testable functions early (`createNavInputHandler`). Call out overflow behavior as a hard gate in the AC. Prefer public API for cross-package access — private fields break silently on upstream changes.

## constrained-tool-sampling — 2025-07-21
**What worked:** Trivial mechanical issue. Voice-of-reason correctly identified no design choice needed. Refactor inlined `as any` mutations into object literals with a shared const — cleaner construction, no indirection.
**What failed:** Builder manually edited bun.lock instead of running `bun install`. Dropped caret ranges on peerDeps. Also added a redundant comment suffix on `@ts-expect-error`.
**Next time:** When bumping versions, always run the package manager to regenerate lockfiles. Never hand-edit bun.lock. Keep `@ts-expect-error` comments focused — one error per directive.

## fix-extension-tools-not-available — 2026-07-26
**What worked:** Seeding `createAgentSession({ tools })` with concrete extension tool names (expanding `tavily/*` before session creation). Pi's `tools` option is a registry allowlist gate, not just an initial-active list: in `_refreshToolRegistry`, when `allowedToolNames` is set, the `includeAllExtensionTools` branch is skipped and any tool not in the set is filtered out of BOTH the registry and the active set. So `setActiveToolsByName` can never activate what was never registered.
**What failed:** The WIP tried to activate extension tools AFTER `bindExtensions` (`setActiveToolsByName([...current, ...missing])`), but those tools were already gated out of the registry at session creation (only builtins passed as `allowedToolNames`). Symptom-level fix on the wrong layer. The parent Pi session works only because it passes no `tools` whitelist at all, hitting `includeAllExtensionTools: true`.
**Root cause was confirmed against pi source, not guessed:** read `agent-session.ts:_refreshToolRegistry` (lines ~2454-2545) and `sdk.ts` (lines ~245-251) to see `options.tools` becomes both `allowedToolNames` and `initialActiveToolNames`. Loader populates `extension.tools` at factory load time (loader.ts: `registerTool()` writes directly), so the `extToolMap` is available pre-session and the wildcard can be expanded before `createAgentSession`.
**Next time:** Registry/allowlist gates reject before you can patch the result. When tools/resources are silently missing, find the gate first (search where the set is built and filtered), and seed it at construction — pushing names in after construction cannot resurrect filtered-out entries. `setActiveToolsByName` silently ignoring unknown names is the tell that the registry, not activation, is the bug.
**Tests masked the bug:** existing runner tests mocked `session.getActiveToolNames()` to already include extension tools, so they exercised `resolveVisibleTools` in isolation and never asserted the `tools` arg to `createAgentSession`. Added a regression test asserting `mockCreateAgentSession.mock.calls[0][0].tools` contains the expanded names.
**Whitelist must gate builtins too (not a nit, a bug):** first cut seeded the gate with `registeredTools` as an unconditional base, so whitelisted agents leaked unlisted builtins into pi's `allowedToolNames` AND leaked raw wildcard literals (`"tavily/*"`) as bogus tool names. The gate must derive from the whitelist expansion alone in whitelist mode. Surfaced a separate preexisting inconsistency: `security-auditor.md` declares `tavily/all` but the resolver only expands `*`; `tavily/all` became a literal bogus name and never worked. That's a data fix in `~/code/ai`, tracked separately.
