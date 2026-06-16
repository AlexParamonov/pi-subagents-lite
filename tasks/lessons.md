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
