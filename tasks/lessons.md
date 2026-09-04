# Lessons Learned

> Only lessons that measurably improve the next outcome survive.

## Ingest (append new lessons at EOF)

> Empty. New `## <name> (<detail>) - YYYY-MM-DD` entries land here.

## agent-color-icons - 2026-08-19
**What worked:** Porting the named color map and hex resolution from the fork was straightforward. Extending `statusIcon` with an optional `agentType` parameter was the right call — single change point, all callers benefit.
**What failed:** First attempt ported the full badge system (background color blocks on agent names). User wanted only the status icon tinted, not the name text. The full badge system (WCAG contrast, 256-color quantization, `renderAgentNameLabel`) was overkill for coloring a dot.
**Next time:** When porting from the fork, ask "what exactly should change visually?" before porting the full rendering system. The fork's badge is a Claude Code visual identity choice; pi-subagents-lite may want simpler indicators.

## agent-color-icons tests - 2026-08-19
**What worked:** Asserting ANSI pattern (`/\x1b\[38;2;\d+;\d+;\d+m/`) instead of exact RGB values makes tests resilient to color value changes.
**What failed:** Tests initially hardcoded exact RGB values (e.g. `220;38;38` for red), then broke when the named color map was corrected to match the fork's values.
**Next time:** Test behavior (icon IS colored, name is NOT), not implementation (exact RGB). Use regex patterns for ANSI output.

## fix-max-tokens-param - 2026-09-04
**What worked:** code-researcher traces pinned the single translation point and compat chain with file:line evidence; review loop caught a real anthropic regression before merge; second review identified the true root cause from the error label (failing model rides the responses API, not completions).
**What failed:** first fix scoped to openai-completions without checking which API family the failing model uses, so both reported cases still 400d after merge; assumed sibling model coverage without testing the exact reported model plus provider strings.
**Next time:** for provider param rejections, first identify the API family from the exact reported model string, then scope the fix; retest the verbatim reported cases, not neighboring ones.

## running-agents-duration-display - 2026-09-04
**What worked:** Frozen-time unit tests pinning exact menu labels plus reusing existing formatMs kept the slice trivial. Voice-of-reason alternatives doc forced explicit choice before build. Review plus refactor loops passed clean with no rework.
**What failed:** None in this slice.
**Next time:** For display-format changes keep reusing the single formatter and assert full label strings, not substrings.
