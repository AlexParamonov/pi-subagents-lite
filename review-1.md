Status: NEEDS_REVISION

# Review Summary

Files reviewed:
- `src/skill-loader.ts`
- `src/prompts.ts`
- `test/skill-loader.test.ts`
- `test/prompts.test.ts`

Issues found:
- 1 critical, 1 important, 1 suggestion

## [CRITICAL] `disableModelInvocation` hardcoded to `false` defeats the filtering

Confidence: 95/100
Location: `src/prompts.ts:106-114`
Problem: When constructing `Skill[]` for `formatSkillsForPrompt`, the code hardcodes `disableModelInvocation: false` for every skill:

```ts
const piSkills: Skill[] = extras.skillMetas.map((m) => ({
  name: m.name,
  description: m.description,
  filePath: m.location,
  baseDir: "",
  sourceInfo: {} as any,
  disableModelInvocation: false,  // ← always false
}));
```

This means `formatSkillsForPrompt` will never filter out a skill marked `disable-model-invocation: true` in its frontmatter. The comment on line 102 even says "disable-model-invocation filtering" is the intended purpose, but the flag is never passed through.

Why it matters: Acceptance criterion: "Skills with `disable-model-invocation: true` in frontmatter are excluded from the `<available_skills>` prompt block (handled by `formatSkillsForPrompt`)". This criterion is not met.

Fix: Add `disableModelInvocation` to the `SkillMeta` interface and thread it from `loadAllSkills` results. `Pi's Skill` type already carries the correct value from frontmatter parsing.

In `src/skill-loader.ts`, update `SkillMeta` and `loadSkillMeta`:

```ts
export interface SkillMeta {
  name: string;
  description: string;
  location: string;
  disableModelInvocation: boolean;
  content?: string;
}

// In loadSkillMeta:
export function loadSkillMeta(skillNames: string[], cwd: string): SkillMeta[] {
  const skills = loadAllSkills(cwd);  // single call
  return skillNames.map((name) => {
    const match = skills.find((s) => s.name === name);
    if (!match) {
      return {
        name,
        description: `(Skill "${name}" not found)`,
        location: "",
        disableModelInvocation: false,
      };
    }
    return {
      name,
      description: match.description ?? "(no description)",
      location: match.filePath,
      disableModelInvocation: match.disableModelInvocation ?? false,
    };
  });
}
```

In `src/prompts.ts`, use the real value:

```ts
const piSkills: Skill[] = extras.skillMetas.map((m) => ({
  name: m.name,
  description: m.description,
  filePath: m.location,
  baseDir: "",
  sourceInfo: {} as any,
  disableModelInvocation: m.disableModelInvocation ?? false,
}));
```

Note: This also fixes the double `loadAllSkills` call in `loadSkillMeta` (see suggestion below).

## [IMPORTANT] Test for `extractDescriptionFromContent` doesn't test description extraction

Confidence: 85/100
Location: `test/skill-loader.test.ts:379-383`
Problem: The test named `extractDescriptionFromContent` only tests the "not found" path:

```ts
describe("extractDescriptionFromContent", () => {
  it("returns empty string when no description in content", () => {
    const result = preloadSkills(["nonexistent"], tmpDir);
    expect(result[0].description).toBe("");
  });
});
```

The old `parseFrontmatterDescription` tests (valid frontmatter, no frontmatter, unclosed frontmatter, empty description, CRLF, quote stripping, truncation) were all removed. The replacement test doesn't exercise the regex extraction at all. If the `extractDescriptionFromContent` regex broke, no test would catch it.

Why it matters: The regex-based frontmatter parsing in `extractDescriptionFromContent` has edge cases (CRLF, unclosed frontmatter, quote stripping, truncation) that were previously tested. This is a regression in test coverage.

Fix: Add tests for `extractDescriptionFromContent` covering the key behaviors. Since it's now internal, test through `preloadSkills` with mocked `loadSkills` returning skills whose file content exercises the parser:

```ts
describe("extractDescriptionFromContent", () => {
  it("extracts description from frontmatter in skill content", () => {
    createSkillDir(tmpDir, "test-skill", "My skill description", "Body");
    const skillPath = join(tmpDir, ".pi", "skills", "test-skill", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("test-skill", "My skill description", skillPath)],
      diagnostics: [],
    });
    const result = preloadSkills(["test-skill"], tmpDir);
    expect(result[0].description).toBe("My skill description");
  });

  it("returns empty description when content has no frontmatter", () => {
    const skillPath = join(tmpDir, ".pi", "skills", "plain", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("plain", "", skillPath)],
      diagnostics: [],
    });
    // Write plain content without frontmatter
    mkdirSync(join(tmpDir, ".pi", "skills", "plain"), { recursive: true });
    writeFileSync(skillPath, "Just body text, no frontmatter.");
    const result = preloadSkills(["plain"], tmpDir);
    expect(result[0].description).toBe("");
  });
});
```

## [SUGGESTION] Unused `writeFileSync` import in test file

Confidence: 80/100
Location: `test/skill-loader.test.ts:5`
Problem: `writeFileSync` is imported but never used in the test file. The old code used it; the refactored tests use the fixture helpers instead.

Fix: Remove `writeFileSync` from the import:

```ts
import { mkdirSync, rmSync } from "node:fs";
```
