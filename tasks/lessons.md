# Lessons Learned

## Common Patterns

### Worktrees
- Clean up worktrees after merge — leave nothing behind
- Slice worktrees must branch from feature branch HEAD, not main
- Wave 2+ worktrees need Wave 1 cleanup first (stale branches)
- Verify worktree path exists before spawning reviewers post-cleanup
- Untracked files in worktrees must be committed or deleted before merge

### Testing
- ALWAYS run `bun run test` after merging to main — don't assume clean merge means passing tests
- Acceptance tests should match planned interface (plan.md), not guessed implementation
- When AC review returns NEEDS_REVISION on recently fixed code, re-review fresh
- User manual testing result ("all works") → record and proceed, don't insist on automated loop

### Delegation
- Delegate immediately without pre-reading files — agent explores itself
- For simple tasks, propose 2-3 name/design alternatives upfront instead of iterating
- Wave-level arch review catches incomplete feature branches — valuable checkpoint

### Parallel Execution
- Parallel slice execution (2+ slices simultaneously) consistently saves time
- Feature worktree per feature, slice worktrees from latest HEAD

### Verification
- When merge agent reports success, verify the actual merge commit exists
- Don't assume — verify. Code review catches silent production bugs (e.g., porcelain format mismatches)

### Delegating parallel sub-agents
- When spawning parallel sub-agents that each write a design doc, mandate a distinct
  output path per agent in the brief. Two agents writing to the same path silently
  clobber each other, and gitignored task dirs leave no history to recover from.
  Task design files under `tasks/` are gitignored, so there is no `git` safety net.

## composition-root-plan - 2026-06-16
**What worked:** Existing implementation was already complete; typecheck fix was the only change needed. ConfigStore unit tests with in-memory IO provide excellent behavioral coverage.
**What failed:** Initial agent spawn used wrong agent type (general-purpose instead of builder).
**Next time:** Always verify agent type matches workflow specification before spawning.

### Agent Type Enforcement
- NEVER use `general-purpose` when workflow specifies specialized agent type
- Check workflow documentation for exact `agent` field values before spawning
- build_issue workflow requires: builder, code-reviewer, refactor, manual-tester
- Violation causes user correction and workflow restart

## config-store-migration - 2026-06-16
**What worked:** Clean 3-commit structure (1c readers, 1d writers, 1e deletions). Refactor caught 6 dead code items across 6 focused commits. Test count dropped from 610 to 529 after deleting config-mutator.test.ts.
**What failed:** Merge had stash conflicts from pre-merge uncommitted changes. Had to discard stashed work.
**Next time:** Ensure worktree is clean before merge. Stash conflicts indicate work-in-progress that should be committed or discarded first.

## spawn-coordinator - 2026-06-16
**What worked:** Clean architecture with coordinator owning liveView and nudge. Widget integration via getLiveView callback preserved backward compatibility. Refactor removed 102 lines of dead code.
**What failed:** Initial builder misunderstood task, implemented session override instead of SpawnCoordinator. Review caught missing widget integration (reading from empty agentActivity map).
**Next time:** Verify builder reads issue.md and plan spec before implementing. Integration gaps between coordinator and widget are high-risk — test data flow end-to-end.

## shell-composition-root - 2026-06-16
**What worked:** Clean state.ts deletion, shell.ts introduced with getter functions. All 557 tests pass. Composition root pattern established.
**What failed:** Mock count not reduced — shell is still module singleton requiring vi.mock(). True DI would need closure/factory pattern.
**Next time:** For mock count reduction, pass shell into functions via closure (factory pattern) instead of module-level singleton. Or accept module singleton as sufficient — the composition root goal is achieved.

## widget-regression - 2026-06-16
**What worked:** Systematic debug process identified root cause in 5 minutes. Fix in SpawnCoordinator benefits both spawn paths.
**What failed:** When unifying spawn paths, missed that menu path called ensureTimer() but tool path didn't. Both paths need the same widget initialization.
**Next time:** When unifying code paths, diff the old paths to ensure all side effects are preserved. Widget lifecycle (ensureTimer, setUICtx) must happen in both paths.

## test-mock-cleanup - 2026-06-16
**What worked:** Clear evidence-based planning (ADR 0004, empirical mock count table) made the issue crisp. Builder correctly identified all cargo-culted mocks and extracted 14 factories. Refactor pruned 7 unused ones (YAGNI).
**What failed:** Builder extracted speculative factories that had zero consumers — classic premature abstraction.
**Next time:** Only extract mock factories that have ≥1 consumer in the current slice. Speculative extraction is waste.
