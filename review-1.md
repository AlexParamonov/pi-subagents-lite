Status: APPROVED

# Review Summary

Files reviewed:
- `src/prompts.ts` (diff: +50/-4)
- `test/prompts.test.ts` (diff: +226)

Issues found:
- 0 critical, 0 important, 0 suggestions

## Acceptance Criteria Coverage

| Criterion | Verdict | Evidence |
|---|---|---|
| Strip `<project_context>...</project_context>` | ✅ | Regex on line 53 + test "strips <project_context> block" |
| Strip skills block (intro + `<available_skills>`) | ✅ | Regex on line 59 + test "strips skills block" |
| Strip `Current date:` line | ✅ | Regex on line 63 + dedicated test |
| Strip `Current working directory:` line | ✅ | Regex on line 66 + dedicated test |
| Preserve base prompt content | ✅ | "strips all scaffolding sections together" asserts base content present |
| Idempotent (absent sections) | ✅ | "is idempotent" test, plus "handles empty parent prompt" |
| `includeContextFiles: true` still injects AGENTS.md | ✅ | Dedicated test verifies old stripped, new injected |
| `includeContextFiles: false` no regression | ✅ | Existing context-files describe block unchanged |
| Per-agent `skills` still controls injection | ✅ | Dedicated test verifies old stripped, new injected |
| Replace mode unaffected | ✅ | Existing replace mode test unchanged + new regression test |
| Custom mode unaffected | ✅ | Existing custom mode test unchanged + new regression test |

## Implementation Analysis

**`stripScaffolding` (lines 40-73):** Clean, well-documented function. Each regex targets a specific scaffolding delimiter per the issue's constraint. The approach is sound:

1. Non-greedy `[\s\S]*?` correctly matches across lines without over-reaching.
2. The optional non-capturing group `(?:The following skills provide[\s\S]*?)?` handles both with-intro and without-intro skills blocks.
3. Newline cleanup (`\n{3,}` → `\n\n`) + `trim()` prevents whitespace artifacts.
4. Only called in inherit mode with a truthy `rawHeader` (line 146-147), so replace/custom modes are completely unaffected.

**Existing test compatibility:** The inherit mode test at line 129 passes `parentPrompt = "You are the parent agent..."` (no scaffolding). `stripScaffolding` returns it unchanged. The `startsWith(parentPrompt)` assertion still holds. No regression.

## Test Quality

13 new tests in the `buildAgentPrompt — inherit mode scaffolding stripping` describe block. All tests:

- **Use public API** (`buildAgentPrompt`) — no deep internal access to `stripScaffolding`
- **Test behavior, not existence** — assert what's present/absent in output, not `respond_to?` or type checks
- **Self-contained** — each test creates its own parent prompt, no shared mutable state
- **Descriptive names** — test titles document the exact scenario
- **One concept per test** — individual sections tested separately, then combined
- **Cover edge cases** — empty prompt, only-scaffolding prompt, special characters, idempotency

The tests verify the critical integration properties:
- Old context stripped, new context injected (line 464-469)
- Old skills stripped, new skills injected (line 483-489)
- Fallback to replace mode when prompt is empty (line 417-423)
- No cross-mode contamination (lines 495-507)

## Strengths

1. Minimal footprint — one exported function + one conditional in `buildAgentPrompt`. No changes to `agent-runner.ts` needed.
2. Regex patterns are targeted to known scaffolding delimiters, not arbitrary XML stripping.
3. The `mode === "inherit" && rawHeader` guard handles undefined, empty string, and whitespace-only parent prompts gracefully (falls back to replace mode).
4. Good defensive coding: `[\s]*` inside tag brackets handles minor formatting variations.
