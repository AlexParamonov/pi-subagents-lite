# Refactor 3 — Workflows (waves 1, 1R, 2)

## Status

REFACTORED. Removed the unused path from the internal workflow-resolution result and its test assertions. Commit: `cdaeabe` (`refactor(workflows): drop unused resolution path`).

## Refactoring summary

- **Dead data / unnecessary return value → Remove Variable/Field.** `WorkflowResolution` carried `filePath` on successful resolution, but production callers only consume `definition` and `listingChanged`. Removed the field from both success paths and the type, along with assertions that tested it. The listing's `filePath` remains: `readListedFile` needs it to re-read current disk contents on each tool call (US-32). This narrows the internal result without changing resolution behavior.
- **Evidence:** `vp check` passed with no warnings, lint, or type errors; `vp test run` passed, 130 files / 2907 tests. `git diff --check` passed. The resolution tests still cover the resolved definition, on-demand rescan, and fresh disk reads.

## Challenge phase

Kept the run/monitor closure, retry state, stop arbitration, ownership claims, endpoint validation, credential redaction and SSE admission: these mechanisms enforce explicit lifecycle, security, and protocol requirements in the spec and wave criteria. No measured basis supports changing their frequency or algorithms. Other returned discovery metadata is consumed by the tool/schema or required to re-read current files.

## Remaining concerns

No refactoring concern found in this scope beyond the removed redundant field. The real endpoint/Pi live gate was not rerun; this internal result-shape cleanup does not touch transport or runtime behavior.
