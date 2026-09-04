# Lessons Learned

> Only lessons that measurably improve the next outcome survive.

## Ingest (append new lessons at EOF)

> Empty. New `## <name> (<detail>) - YYYY-MM-DD` entries land here.

## agent-color-icons (scope + tests) - 2026-08-19

**What worked:** Extending `statusIcon` with an optional `agentType` parameter was the right call — single change point, all callers benefit. Asserting the ANSI pattern (`/\x1b\[38;2;\d+;\d+;\d+m/`) instead of exact RGB values keeps tests resilient.
**What failed:** First attempt ported the fork's full badge system (WCAG contrast, 256-color quantization, `renderAgentNameLabel`) when only the status-icon tint was wanted. Tests hardcoding exact RGB values broke when the color map was corrected to the fork's values.
**Next time:** When porting from the fork, confirm the exact visual change before porting the rendering system. Assert full observable output (icon IS colored, name is NOT) and pattern-match volatile segments.

## fix-max-tokens (api-family first) - 2026-09-04

**What worked:** Verifying each API against the installed pi source settled the responses overlap without rework; the alternatives menu picked unified payload-path over model-clone and flat swap; manual tester confirmed the exact previously failing model live.
**What failed:** First fix scoped to openai-completions without checking which API family the exact reported model string rides, so both reported cases still 400d after merge; assumed sibling-model coverage without testing the verbatim reported model plus provider strings.
**Next time:** Identify the API family from the exact reported model string before scoping the fix — pi-ai does not export its resolution, so verify against installed pi source. Retest the verbatim reported cases, not neighboring ones.

## running-agents-duration-display - 2026-09-04

**What worked:** Frozen-time unit tests pinning exact menu labels plus reusing the existing `formatMs` kept the slice trivial with no rework.
**What failed:** None in this slice.
**Next time:** For display-format changes reuse the single formatter and assert full label strings, not substrings.

## validate-config-on-load (project-key scope) - 2026-09-04

**What worked:** TRIVIAL alternatives verdict still surfaced the one genuine decision (unknown agent keys as per-type model keys); per-key TypeBox schema map with error-path mapping dropped fork shapes with loud warnings while valid keys survived.
**What failed:** Manual tester used global-only `graceTurns` in a project file as the valid-key-kept case and got a correct second warning, since project files accept only model-family plus per-type keys by design (`isProjectAllowedAgentKey`).
**Next time:** For manual config scenarios use per-type overrides in project files, not global-only keys.

## pi-toolchain-0.85 (lockfile-only pin) - 2026-09-04

**What worked:** Keeping the pi toolchain version pinned only in the lockfile (no devDep; peers `>=0.82.0` auto-install) made the 0.85 upgrade attempt a pure `npm update` with zero manifest churn, and the failure was instantly diagnosable to pi's packaging rather than our code.
**What failed:** pi-coding-agent 0.85.0's dist bare-imports the undeclared `@earendil-works/pi-server` (`index.js` → `main.js` → `experimental/server.js`), so 44 test files die on `ERR_MODULE_NOT_FOUND` at import, before any assertion runs.
**Next time:** Before `npm update` of the pi toolchain, check pi's release notes for packaging changes. If the tree goes red with module-not-found inside pi's dist, hold the lockfile until pi ships the fix or install the missing package explicitly.

## typebox-peer (host-owned schema library) - 2026-09-04

**What worked:** Migrating to the unscoped `typebox` package at pi's own exact pin (1.3.7) and declaring it a peer: pi's extension loader aliases `typebox`/`typebox/value` to the host's copy in every runtime mode (jiti aliases, SEA virtualModules), dev/CI gets it via npm peer auto-install, and emitted schemas were unchanged, so the whole suite passed without assertion edits.
**What failed:** The extension built schemas with `@sinclair/typebox` 0.34 — a package the pi host does not ship — so the two schema lineages drifted; typebox 1.x's thin base `TSchema` then broke seven test typechecks that poked at concrete fields (`type`, `anyOf`, `additionalProperties`).
**Next time:** Import `Type`/`TSchema` from `typebox` and `Check` from `typebox/value`, never `@sinclair/typebox`. When tests assert schema internals, narrow to the emitted JSON shape via a structural view instead of the library interfaces.
