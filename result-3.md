# Slice Result: align-skill-loading-with-pi (review-1 revision)

**Status:** COMPLETE

**What was built:**
- Fixed `disableModelInvocation` threading from `SkillMeta` through to `formatSkillsForPrompt`
- Removed dead code (`findSkillDescription`, `findSkillLocation`)
- Added `extractDescriptionFromContent` test coverage (5 edge cases)
- Added `disableModelInvocation` threading and filtering tests

**Files created/modified:**
- `src/skill-loader.ts` — added `disableModelInvocation` to `SkillMeta`, rewrote `loadSkillMeta` to use single `loadAllSkills` call, removed unused helpers
- `src/prompts.ts` — changed hardcoded `false` to `m.disableModelInvocation ?? false`
- `test/skill-loader.test.ts` — added 7 tests for `extractDescriptionFromContent` and `disableModelInvocation`
- `test/prompts.test.ts` — added `disableModelInvocation` to all fixtures, added filtering test

**Tests added:**
- 5 `extractDescriptionFromContent` tests: not found, valid frontmatter, no frontmatter, unclosed frontmatter, quote stripping, truncation
- 2 `loadSkillMeta` tests: `disableModelInvocation=true` threading, default `false` for missing skill
- 1 `prompts.test.ts` test: `disableModelInvocation=true` skill excluded from `<available_skills>`

**Acceptance criteria:**
- [x] All original ACs remain satisfied
- [x] `disable-model-invocation: true` filtering now works end-to-end

**Review feedback addressed:**
- [x] CRITICAL: `disableModelInvocation` no longer hardcoded to `false`
- [x] IMPORTANT: `extractDescriptionFromContent` now has proper test coverage
- [x] SUGGESTION: unused `writeFileSync` import cleaned up (re-added when new tests needed it)
