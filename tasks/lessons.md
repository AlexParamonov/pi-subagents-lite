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
