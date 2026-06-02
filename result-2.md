# Slice Result: session-level cost accumulator

**Status:** COMPLETE

**What was built:**
- Session-level `totalAgentCost` field on AgentManager that accumulates cost across all agent completions
- `getTotalAgentCost()` public getter for the accumulated cost
- Updated `updateStatusBar` in AgentWidget to combine session accumulator + in-flight running agent costs

**Files created/modified:**
- `src/agent-manager.ts` — added `totalAgentCost` field, accumulation in `safeNotifyComplete`, `getTotalAgentCost()` getter
- `src/ui/agent-widget.ts` — updated `updateStatusBar` to use `manager.getTotalAgentCost()` + running cost instead of only running cost
- `test/total-cost-accumulator.test.ts` — new file: 6 tests for accumulator lifecycle (init, accumulate, persist after eviction, multi-agent, failed, stopped)
- `test/agent-widget.test.ts` — added `getTotalAgentCost` mock, 3 new tests for status bar cost display (accumulator + running, accumulator-only, hidden when toggle off)

**Tests added:**
- 6 unit tests for totalAgentCost accumulator (zero init, accumulate on complete, survive eviction, multi-agent, failed, stopped)
- 3 widget integration tests for status bar cost display

**Acceptance criteria:**
- [x] Status bar appends accumulated agent cost when > $0 (uses session accumulator + running costs)
- [x] Cost survives agent eviction (accumulator persists for session lifetime)
- [x] Cost hidden when showCost setting is OFF
- [x] Running agents' in-flight costs are included alongside accumulated session cost

**Deviations:**
- None

**Blockers:**
- None

**Research needed:**
- None
