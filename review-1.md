Status: APPROVED

# Review Summary

Files reviewed:
- `test/fixtures.ts` (modified — shared mock factories added)
- `test/agent-status-tool.test.ts` (modified — 11 → 1 mock)
- `test/build-agent-details.test.ts` (modified — 11 → 0 mocks)
- `test/stop-agent-tool.test.ts` (modified — 11 → 1 mock)
- `test/stop-agent-inline.test.ts` (modified — 11 → 1 mock)
- `test/nudge-status-message.test.ts` (modified — 13 → 2 mocks)
- `test/index.test.ts` (modified — uses shared factories for typebox, pi-coding-agent, agent-discovery, agent-runner, default-agents)

Issues found:
- 0 critical, 0 important, 1 suggestion

## Acceptance Criteria Verification

| AC | Status | Notes |
|---|---|---|
| `stop-agent-tool.test.ts` mock count < 8 | ✅ | 1 mock (shell.js) |
| `stop-agent-inline.test.ts` mock count < 8 | ✅ | 1 mock (shell.js) |
| `nudge-status-message.test.ts` mock count < 10 | ✅ | 2 mocks (shell.js, usage.js) |
| `build-agent-details.test.ts` mock count < 8 | ✅ | 0 mocks — pure function, verified correct |
| `agent-status-tool.test.ts` mock count < 8 | ✅ | 1 mock (shell.js) |
| Shared mock factories exported from `test/fixtures.ts` | ✅ | 14 factories: typeBoxMock, piTuiMock, piCodingAgentMock, agentTypesMock, agentDiscoveryMock, agentRunnerMock, defaultAgentsMock, modelSelectorMock, modelPrecedenceMock, agentWidgetMock, shellMock, usageMock, worktreeValidatorMock, utilsMock |
| Typebox mock normalized to one canonical factory | ✅ | All files use `typeBoxMock()` (createType helper form) |
| No production source changes | ✅ | `diff -rq src/ .git/buildtrees/test-mock-cleanup/src/` — no differences |
| Test assertions preserved | ✅ | All test names and expect() calls identical between current and buildtree |
| `tasks/standalone/closure-factory-pattern/issue.md` deleted | ✅ | Already absent |

## Correctness Analysis

**Import chain validation:** The key insight driving this cleanup is verified — the runtime import chain from the 5 target test modules' SUTs never reaches npm packages:

- `agent-status.ts` → `types.js`, `shell.js` (all local)
- `tool-execution.ts` → `agent-types.js`, `usage.js`, `worktree-validator.js`, `utils.js`, `shell.js` (all local, npm deps are `import type` → erased)
- `shell.ts` → `config-store.js` (local); npm deps are `import type` → erased

**build-agent-details.test.ts (0 mocks):** Correctly removes all mocks. `buildAgentDetails` is a pure function that reads from the record and calls `getLifetimeTotal`/`getSessionContextPercent` from `usage.js`. The entire import chain is local modules. Verified that `tool-execution.ts` imports only local modules at runtime.

**shellMock factory:** The `ShellMockFns` interface with partial override semantics works correctly. A test passing `{ manager: { listAgents: mockListAgents } }` gets a manager with test-provided `listAgents` plus default stubs for `abort`, `getRecord`, `spawn`, `getTotalAgentCost` — preventing undefined-call crashes if any code path touches those methods.

**nudge-status-message.test.ts shell mock pattern:** The spread-then-override pattern (`{ ...shellMock({...}), getCoordinator: () => coordinator }`) correctly provides the real `SpawnCoordinator` instance to the mock while reusing `shellMock` for all other exports. The `coordinator` variable is captured by the vi.mock factory's closure and is initialized before the factory executes (triggered by the import after the mock block).

**Test assertion preservation:** Verified via `diff <(grep -E 'expect\(|it\(' ...) <(grep -E 'expect\(|it\(' ...)` — all test names and assertions are byte-identical between current and buildtree versions.

## Strengths

1. **Clean separation of concerns**: Static mocks (typeBoxMock, piTuiMock, etc.) as simple factory functions; per-test-overridable mocks (shellMock, usageMock) accept hoisted fns via parameterized builders. This respects the Vitest hoisting constraint — `vi.mock()` calls stay in each file, only the factory bodies are deduplicated.

2. **Dramatic mock reduction**: From 57 total mocks across 5 files to 5 total. Each file mocks only the modules it actually touches at runtime. Eliminates the false-confidence risk where a cargo-culted mock masks a real import issue.

3. **Canonical typebox factory**: The two divergent variants (createType helper vs inline shorthand) are normalized to one form. The `createType` helper is the canonical choice — it works whether the caller invokes the type function or references it directly.

4. **shellMock default stubs**: The `ShellMockFns` interface with defaults prevents the common pattern where test B copies test A's mock but omits a field, causing a cryptic `TypeError: ... is not a function` at runtime. Every missing field gets a safe default.

5. **No production changes**: Strictly test-only refactoring. No `src/` files touched.

---

## [SUGGESTION] Several exported mock factories in fixtures.ts are never used

Confidence: 80/100
Location: `test/fixtures.ts` — `piTuiMock()`, `agentTypesMock()`, `modelSelectorMock()`, `modelPrecedenceMock()`, `agentWidgetMock()`, `worktreeValidatorMock()`, `utilsMock()`
Problem: 7 of 14 exported mock factory functions are not imported by any test file. `grep -rn 'piTuiMock\|agentTypesMock\|modelSelectorMock\|modelPrecedenceMock\|agentWidgetMock\|worktreeValidatorMock\|utilsMock' test/*.ts` returns zero matches outside `fixtures.ts`.
Why it matters: Dead exports increase maintenance surface. If the underlying module API changes, these factories silently drift. A reader might assume they're used and trust them as the canonical mock shape.
Fix: Either (a) delete unused factories and re-add when needed, or (b) add a comment `// Available but not yet used by any test` to clarify intent. Low priority — these are safe to keep as documentation of the mock shape.
