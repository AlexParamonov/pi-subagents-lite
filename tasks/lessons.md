# Lessons Learned

## General

### Worktrees
- Clean up after merge: commit/discard untracked files first. Verify path exists before spawning reviewers.
- Slice from feature branch HEAD, not main. Wave 2+ needs Wave 1 cleanup first.
- Always verify worktree branch exists and is checked out before spawning builder.

### Testing
- Always `bun run test` after merging to main; clean merge ≠ passing tests.
- Acceptance tests match planned interface (plan.md), not guessed implementation.
- Test public interfaces and behavior, not implementation details or hardcoded data.
- User manual testing result ("all works") → record and proceed, don't insist on automated loop.
- When AC review returns NEEDS_REVISION on recently fixed code, re-review fresh.
- Tests must interact through component tree, not captured mock references.
- Export testable functions early to avoid mock ceremony.
- Existing tests that mock away the real path mask the bug. Assert constructor args, not just downstream behavior.
- When a range edit targets code that shifted since the last read, it can clobber adjacent signatures (replaced a function header, orphaned its body). Re-read the region before multi-line replaces, and check the parse after.

### Delegation
- Delegate immediately without pre-reading files — agent explores itself.
- For simple tasks, propose 2-3 name/design alternatives upfront.
- Wave-level arch review catches incomplete feature branches.
- Parallel sub-agents writing design docs: mandate distinct output paths per agent.
- Parallel slice execution (2+ slices) consistently saves time.

### Verification
- When merge agent reports success, verify the actual merge commit exists.
- Don't assume — verify. Code review catches silent production bugs.
- `ExtensionAPI` (pi) rejects calls to old ctx. Add try-catch around sendMessage for defense-in-depth.
- A trailing `?? N` fallback on optional config fields looks dead but is forced by `T | undefined` static type. Run typecheck before removing "redundant" fallbacks.
- Never use `general-purpose` when workflow specifies a specialized agent type. Check workflow docs for exact `agent` values before spawning.

### Config & Refactoring
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

### Subagent Session Lifecycle
- Subagents are built with `createAgentSession`, which runs its own `DefaultResourceLoader.reload()` and `session.bindExtensions()`. That re-executes EVERY extension factory and re-fires `session_start`/`session_shutdown` in the subagent's context, NOT just the parent's.
- An extension that writes parent-owned state in its factory or `session_start` handler (module-level shell singletons like `pi`/`ctx`) will have that state clobbered by every subagent spawn. Last subagent to load wins, so later reads route to a dead/wrong session. Failures are silent because misrouted `sendMessage` swallows internally.
- Fix: bracket the subagent entry point (`runAgent`) with a nesting-depth flag. Make the factory + `session_start`/`session_shutdown` handlers a no-op while a subagent is in flight. Parent reload still refreshes the shell (flag is false outside `runAgent`). `dispose()` gates deferred work after `session_shutdown`.
- `AgentSession.dispose()` does NOT emit `session_shutdown` (only the interactive runtime's `teardownCurrent` does). So subagent cleanup won't dispose parent state, but subagent `bindExtensions` WILL fire the parent's `session_start` handler.

### Extension Tools
- Registry/allowlist gates reject before you can patch the result. When tools/resources are silently missing, find the gate first (search where the set is built and filtered), and seed it at construction — pushing names in after construction cannot resurrect filtered-out entries. `setActiveToolsByName` silently ignoring unknown names is the tell that the registry, not activation, is the bug.
- Seeding `createAgentSession({ tools })` with concrete extension tool names (expanding `tavily/*` before session creation). Pi's `tools` option is a registry allowlist gate, not just an initial-active list.
- Whitelist must gate builtins too. Seeding gate with `registeredTools` as unconditional base leaks unlisted builtins and raw wildcard literals as bogus tool names. Gate must derive from whitelist expansion alone in whitelist mode.
- Confirmed against pi source: `agent-session.ts:_refreshToolRegistry` (~2454-2545) and `sdk.ts` (~245-251). `options.tools` becomes both `allowedToolNames` and `initialActiveToolNames`.

### SettingsList
- Supports: toggles, submenus, section separators (`__sep__` items), static display.
- Does NOT support: multi-step dialogs, action buttons, dynamic item sets.
- Never call `ctx.ui.input/select/custom` from within active SettingsList. Design submenu-Component layer before touching complex menus.
- Dispatcher menus → `ctx.ui.select` with `while(true)` loop. SettingsList only for cursor-persistence menus. SettingsList + async select submenus don't mix.

### Menus & Components
- Proxy pattern (`createDelegatingComponent`) chains submenus cleanly. Shared submenu components earned keep with 2-3 uses each.
- When submenu callbacks chain Components, verify returned Component is renderable, not immediately closed.
- Breaking `extensionPackageName` into memoizing wrapper + pure resolver clarifies concerns. `.has()` presence check solves negative caching bugs cleanly. Use `.has()` for nullable caches, not value-guard patterns.

### Issue Design
- Prototype code blocks in issue.md (state machine, key handler) give builder a clear contract.
- Call out overflow behavior as a hard gate in the AC.
- Prefer public API for cross-package access — private fields break silently on upstream changes.
- Specify test location and approach in the issue or builder prompt. "Test frontmatter parsing of max" not "cover max in tests".
- Single meaningful behavior test beats multiple implementation tests on a one-liner.

### Buffer & Error Patterns
- Buffer-then-flush pattern is the simplest fix for ordering/corruption issues. When deferring side effects, always consider error paths. try/finally guarantees flush.
- When nudges stop working, restart harness rather than debugging live state.

### Package Management
- When bumping versions, always run the package manager to regenerate lockfiles. Never hand-edit bun.lock.
- Keep `@ts-expect-error` comments focused — one error per directive.


### Cross-Platform
- `process.env.HOME` is unreliable on Windows. Use SDK's `getAgentDir()` or `os.homedir()` instead.
- Check existing PRs for reference implementations before grilling alternatives — PR #12 already solved this issue.

### Refactor Scope
- Refactor agent should stay within issue scope. Mock pattern improvements are out-of-scope for a trust-gate issue.
- If refactor hits a vitest ordering issue (vi.mock vs vi.hoisted), stop and move on — the code works.

### Model-Aware UI Filtering
- Use library-provided helpers (getSupportedThinkingLevels, clampThinkingLevel) instead of reimplementing filtering logic.
- Submenu pattern (lazy evaluation) works well for dynamic option lists — avoids SettingsList rebuild complexity.
- Grill thoroughly: user corrected scope twice (no Model settings change, non-reasoning shows only off).

## agent-stats-cleanup - 2025-01-27
**What worked:** Grilling session clarified format requirements through iterative refinement. Two formats (full/compact) with config toggle gave user flexibility. Review caught test assertion bug and untested code path. Refactor extracted `buildStatusBarText` for clarity.
**What failed:** Builder initially implemented format without config toggle; had to re-spawn for scope addition. First review found misleading test name and `drainQueue` catch block violating AC.
**Next time:** Clarify format variations upfront during grill. Check `drainQueue` catch blocks for counter increments. Test names must match assertions.

## surface-subagent-model-errors - 2026-08-01
**What worked:** Investigation first: traced the full silent-failure chain (pi-ai emits stopReason "error" assistant message with empty content instead of throwing; extension read only text blocks so result came back empty; record marked completed). Writing the mechanism into the issue gave the builder a precise contract. Detection on the final assistant message only — transient errors followed by a successful turn don't fail the run. Status precedence ladder (stopped > aborted > error > turn_limited > completed) pinned by tests.
**What failed:** Manual live-session test not possible (no API keys in env) — fell back to code inspection + suite, per repo precedent. Builder flagged a behavior deviation (turn-limited run whose final message is a provider error records error, not turn_limited) that the issue's AC wording had not anticipated; reviewer accepted it as more truthful.
**Next time:** For error-surfacing work in pi extensions, state in the issue that the provider error arrives as an assistant message with stopReason "error" (not a throw) — it's the load-bearing fact. Acknowledge the error-vs-turn_limited overlap explicitly in ACs. Note that a lessons.md entry committed inside a feature diff is fine as long as it matches the file's style.

## fix-default-thinking-fallback - 2026-08-01
**What worked:** Issue pinpointed both buggy sites with exact line refs and the correct resolution chain, so the builder could go straight to TDD (8 regression tests: 2 red for the missing fallback, 6 green guarding precedence). Both spawn paths (menu-driven wizard, LLM-driven tool call + listener) now share one chain: explicit param > frontmatter > store default > inherit. New test file rather than editing the existing tool-execution spec kept the "only modify src/agents/tool-execution.ts" constraint literal.
**What failed:** A path mistake wrote the new test file into the main checkout instead of the git worktree — caught by `git status` before any damage. Also, the worktree file diverged from the main checkout (different commits), so issue line refs and the first read of the main checkout's file didn't match the worktree; had to re-read before editing.
**Next time:** For worktree tasks, read files through the worktree path from the start, never the main checkout. Verify `git status` in the worktree immediately after writing any file.
