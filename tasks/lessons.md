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
