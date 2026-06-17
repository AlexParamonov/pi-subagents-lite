- **Status** — REFACTORED.

- **Refactoring summary** — Simplified `max_tokens` onPayload injection in `agent-runner.ts` from 11 lines to 4 (flattened orig handler chaining, kept minimal type guard for TS spread safety). Extracted `makeMockModel()` factory and shared session `beforeEach` in tests to eliminate 3× duplicated mock model literals (124 → 85 lines). Removed double blank line in `agent-discovery.test.ts`.

- **Commits**:
  - `6cd72ba` refactor: simplify onPayload injection in agent-runner.ts
  - `6caafd4` refactor: extract shared setup and mock model helper in maxTokens tests
  - `285af8c` refactor: remove double blank line in agent-discovery.test.ts
