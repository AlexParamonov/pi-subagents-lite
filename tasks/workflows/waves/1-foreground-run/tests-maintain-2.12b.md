# Test maintenance: foreground workflow architecture fixes

**Result:** CLEANED. Test-only changes; production behavior is unchanged.

## Census correction

Withdrawn from the original report: its 10-file census, expensive-seam tallies, CPU-profile claim, focused-suite timing, and block/LOC figures were not reproducible. No speedup claim remains.

## Changes and stats

- Files touched: 2 test files (`test/config/config-io-workflows.test.ts`, `test/workflows/workflow-tool.test.ts`) plus this report.
- Tests deleted: 2. Moved: 0. Rewritten: 0. Removed one no-op assertion.
- Full suite after cleanup: 125 files, 2,577 tests passed (one plain run; timing withdrawn).
- The tool-routing fake now returns a valid 503 JSON rejection, and `callTool` captures both returned tool errors and thrown errors instead of treating every returned error result as success.
- Checks: affected files passed; `vp check` passed; full `vp test run` passed.

## Deletions

- Removed `warns that a project-only endpoint name is ignored`: the combined one-warning test still names the project-only endpoint, while `mergeLayers — ignores a project-only endpoint name and a project default` pins that the setting has no effect.
- Removed `warns that a defaultEndpoint the project sets is ignored`: the combined one-warning test still names the ignored default, while the same `mergeLayers` test pins that it has no effect.
- Removed `expect(refusal).toBe("")` from the inherited-global-target tool test: `callTool` treats any returned result, including an `isError` result, as an empty refusal. The exact POST URL and authorization assertion is the real pin; the deleted assertion could not prove success.
