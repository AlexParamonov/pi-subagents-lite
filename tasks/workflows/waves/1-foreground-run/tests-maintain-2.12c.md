# Maintenance review revision: foreground workflow run

**Status:** CLEANED — findings addressed with test/comment/report-only edits; production files unchanged.

## Stats

- Files touched: 5 (3 test files and 2 maintenance reports). Test cases added: 3 (global `constructor`, global `toString`, create response without a workflow id); deleted/moved/rewritten: 0.
- Test declaration blocks: 121 → 123. Executed tests: 129 → 132. Test LOC: 2,328 → 2,355.
- Count scope: `test/config/config-io-workflows.test.ts`, `test/workflows/workflow-client.test.ts`, and `test/workflows/workflow-tool.test.ts`. LOC is raw `wc -l` across those files; declaration blocks are source `it(`/`test(` calls; executed test counts are the Vitest totals for those same files. The two prototype names are generated from one loop declaration.
- Expensive seam census (source call expressions, excluding helper definitions): `createConfigIO` 19 → 20; `ConfigStore` 6 → 6; `remote` loopback-fixture calls 44 → 44; `startSession` extension/session calls 7 → 7. `remote` creates the real loopback endpoint, so the helper call count includes its wrapped endpoint seam.
- Three plain focused runs (`vp test run test/config/config-io-workflows.test.ts test/workflows/workflow-client.test.ts test/workflows/workflow-tool.test.ts`): median 4.49s → 4.49s. Baseline durations/load averages: 4.48s (2.81/2.40/2.14), 4.49s (2.91/2.43/2.15), 4.50s (2.68/2.39/2.14). After durations/load averages: 4.49s (3.02/2.47/2.17), 4.48s (3.18/2.52/2.18), 4.52s (3.33/2.56/2.20). Load is the 1/5/15-minute `/proc/loadavg` at each run's start. No speedup is claimed.
- No deletions; no deletion pins moved or removed.

## Coverage proofs

- Temporarily changed endpoint resolution to refuse explicitly configured `constructor` and `toString`. Both new global-file cases failed with the expected resolution mismatch; restored the production source.
- Temporarily made the client invent an id when `runIds` returned no id. The create-response test failed because it received success instead of the expected refusal; restored the production source.
- The old unrepeatable 10-file census and CPU-profile claims are withdrawn in `tests-maintain-2.12b.md`.

## Checks

- `vp fmt --check` and `vp check`: passed.
- `vp test run`: 125 files, 2,580 tests passed in 8.61s.
