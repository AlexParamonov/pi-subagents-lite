# Slice Result: inline-single-consumer-mock-factories

**Status:** COMPLETE

**What was built:**
- Inlined 6 single-consumer mock factories from `test/fixtures.ts` back into their sole consumers
- Kept `shellMock` in `fixtures.ts` as the only genuinely shared mock factory (4 consumers)

**Files created/modified:**
- `test/fixtures.ts` — removed `typeBoxMock`, `piCodingAgentMock`, `agentDiscoveryMock`, `agentRunnerMock`, `defaultAgentsMock`, `usageMock` exports and `UsageMockFns` interface (−103 lines)
- `test/index.test.ts` — inlined 5 mock factories into `vi.mock()` call sites (+54 lines, net +47 with import removal)
- `test/nudge-status-message.test.ts` — inlined `usageMock` into `vi.mock()` call site, removed import

**Tests added:**
- None needed — pure relocation, no behavior change

**Acceptance criteria:**
- [x] `shellMock` kept in `fixtures.ts` with 4 consumers (agent-status-tool, nudge-status-message, stop-agent-inline, stop-agent-tool)
- [x] `typeBoxMock` inlined into `test/index.test.ts` (1 consumer)
- [x] `piCodingAgentMock` inlined into `test/index.test.ts` (1 consumer)
- [x] `agentDiscoveryMock` inlined into `test/index.test.ts` (1 consumer)
- [x] `agentRunnerMock` inlined into `test/index.test.ts` (1 consumer)
- [x] `defaultAgentsMock` inlined into `test/index.test.ts` (1 consumer)
- [x] `usageMock` inlined into `test/nudge-status-message.test.ts` (1 consumer)
- [x] No changes to `src/` files
- [x] No changes to `tasks/lessons.md`
- [x] `bun run typecheck` — clean
- [x] `bun run test` — 557 tests, 29 files, all passing
- [x] `vi.mock` call count unchanged: `index.test.ts` = 10, `nudge-status-message.test.ts` = 2
- [x] Grep confirms no dangling imports of removed factories

**Deviations (if any):**
- None

**Blockers (if any):**
- None

**Research needed (if any):**
- None
