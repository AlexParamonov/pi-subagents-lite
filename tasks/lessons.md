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
