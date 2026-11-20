# Test maintenance: foreground workflow architecture fixes

**Result:** CLEANED. Test-only changes; production behavior is unchanged.

## Census

The reviewed test surface comprised 10 files, 265 `it`/`test` blocks and 5,680 test LOC before this pass. The expensive seams are reached through helpers: 86 extension/session-start call sites (`start`/`startSession`), 105 loopback-server call sites (`server`/`remote`), and 13 `fakeWorkflowFetch` sites. The config suite also has 19 `createConfigIO` and 6 `ConfigStore` call sites.

A recorded CPU profile run for these 10 files is retained at `/tmp/workflows-maint-trace/`. Offline parsing showed worker idle and module loading/compilation dominating samples; it did not identify a test-body hotspot.

## Changes and stats

- Files touched: 2 test files (`test/config/config-io-workflows.test.ts`, `test/workflows/workflow-tool.test.ts`) plus this report.
- Tests deleted: 2. Moved: 0. Rewritten: 0. Removed one no-op assertion.
- Test blocks: 265 → 263.
- Test LOC: 5,680 → 5,662.
- Focused 10-file suite: 291 → 289 executed tests. Before: 6.897s in one plain run (load average 3.37 at start). After: 6.906s median across three plain runs (6.906/6.888/6.922s; start loads 1.54/1.42/1.31). This is within run noise, so no speedup is claimed. Full suite after cleanup: 125 files, 2,577 tests, 8.78s.
- The tool-routing fake now returns a valid 503 JSON rejection, and `callTool` captures both returned tool errors and thrown errors instead of treating every returned error result as success.
- Checks: affected files passed; `vp check` passed; full `vp test run` passed.

## Deletions

- Removed `warns that a project-only endpoint name is ignored`: the combined one-warning test still names the project-only endpoint, while `mergeLayers — ignores a project-only endpoint name and a project default` pins that the setting has no effect.
- Removed `warns that a defaultEndpoint the project sets is ignored`: the combined one-warning test still names the ignored default, while the same `mergeLayers` test pins that it has no effect.
- Removed `expect(refusal).toBe("")` from the inherited-global-target tool test: `callTool` treats any returned result, including an `isError` result, as an empty refusal. The exact POST URL and authorization assertion is the real pin; the deleted assertion could not prove success.
