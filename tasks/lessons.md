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
