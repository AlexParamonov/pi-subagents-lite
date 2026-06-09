## cost-tracker — 2026-05-26

**What worked:**
- Parallel slice execution (slices 2+3 built simultaneously) saved time
- TDD approach caught STATS_OVERHEAD off-by-one error early (review-1 → review-2 fix)
- Clean merge to main with no conflicts

**What failed:**
- STATS_OVERHEAD constant was 1 instead of 2 (spacer + text needs 2 cols) — caught in code review
- Worktrees left behind after merge (cleanup needed reminder)

**What failed:**
- Pre-read files before delegating to subagent — violates AGENTS.md rule "delegate immediately, agent can explore itself"

**Next time:**
- Auto-cleanup worktrees after merge
- Consider adding a post-merge checklist to build_log.md
- When asked to delegate, delegate immediately without pre-reading
- Consider moving the delegation rule from Tool Usage to Rules (mandatory - checkable) for more prominence

## refactor2 — 2026-06-02

**What worked:**
- Parallel slice execution (slices 1+3 built simultaneously) saved time
- Decomposing AgentRecord into 4 sub-objects eliminated flat-field access patterns cleanly
- buildAgentDetails options bag avoided one-function-does-three-things antipattern
- Context percent capture at completion time solved widget→execution leak elegantly
- Wave 1 worktrees needed cleanup before Wave 2 (stale branches)

**What failed:**
- Slice 2 initial review caught execution.session access violation in widget — should have been caught in planning
- Acceptance tests from step 2.4 needed fixing after implementation (expected Red, but test fixtures used old flat structure)
- Merge agent confused Wave 1 slice 3 with Wave 2 slice 3 — had to manually verify and merge
- Worktrees created from main instead of feature branch initially — had to recreate

**Next time:**
- Wave 2 slice worktrees must branch from feature worktree, not main
- Acceptance test writer should use the planned interface (from plan.md) not guess at implementation
- When merge agent reports success, verify the actual merge commit exists in the log
- Clean up old slice worktrees/branches before creating new ones
- ALWAYS run `bun run test` immediately after merging to main — don't assume clean merge means passing tests
- Untracked test files in worktrees must be committed or deleted before merge, not left behind

## worktree-path-param - 2026-06-05
**What worked:**
- Single new module (`worktree-validator.ts`) with `git rev-parse --git-common-dir` comparison — clean, testable seam
- `runAgent` already accepted `cwd` — worktree = validate + pass as `cwd`. Zero changes to `agent-runner.ts` internals
- Acceptance tests written before implementation (Red) gave builders a clear target
- Parallel 1-2 + 1-3 execution cut wall time in half
- Post-merge code review caught no real issues — slices were cleanly additive
- User did manual testing personally; trusted confirmation ("all works") saved running a 10-iteration manual tester loop

**What failed:**
- Acceptance test writer's tests used a different convention than slice builders used — slice 1-1 added their own tests instead of running the acceptance tests, so the acceptance tests stayed Red until later slices and 1-1's AC review had to catch up
- 1-4 initial build had wrong porcelain format `"(detached)"` vs `"detached"` — caught in code review, would have been silent production bug
- 1-2 widget worktree label leaked into compact mode for finished agents — caught in code review
- 1-2 AC review found worktree label and `tail -f` rendered on separate lines instead of one — fixed in second AC pass
- Orchestrator accidentally spawned the planner twice — user caught and stopped; should have waited for the first notification
- AC review for 1-1 returned NEEDS_REVISION with stale findings (predating the result-2 fix) — needed a fresh re-review to confirm

**Next time:**
- The acceptance test writer's tests and the slice builders' tests should be the same tests; consider telling slice builders "use the Red tests in test/ as your suite, do not write a new one"
- When AC review returns NEEDS_REVISION on a slice that has been recently fixed, spawn a fresh re-review rather than relying on the prior report
- Single feature worktree per feature is correct, but slice worktrees should be created from the latest feature branch HEAD (post-merge), not from the original main checkout HEAD — they were here, but easy to mess up
- The wave-level arch review is valuable: caught the fact that main has an incomplete version of this feature
- When user says "I tested manually, all works", record the result and proceed — don't insist on running the manual tester loop

## agent-status — 2026-06-06

**What worked:**
- Single-module tool implementation (50 LOC) — clean, minimal
- Existing `AgentManager.listAgents()` API meant zero new state management
- Stealth schema pattern copied from StopAgent — consistent
- Pre-existing test failures confirmed before merge — avoided false blame

**What failed:**
- Grill session went through 4 rounds of naming clarification — should have asked for alternatives upfront
- Builder agent's CWD got stuck in removed worktree during merge — non-blocking but messy

**Next time:**
- For simple tools, propose 2-3 name alternatives during grill instead of waiting
- Verify worktree path exists before spawning reviewer after merge cleanup
