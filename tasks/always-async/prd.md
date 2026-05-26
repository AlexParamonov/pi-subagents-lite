## Problem Statement

The Agent tool has two spawn paths — foreground (blocking, `spawnAndWait`) and background (async, `spawn`) — that duplicate activity tracking logic and add branching complexity. The foreground path exists to return a rich stats card, but the result is delivered identically to the LLM (as text). Keeping two paths maintains ~60 lines of duplicated setup and a decision point (`runInBackground`) that the LLM must understand.

## Solution

Collapse to a single async spawn path. All agents start in the background, results are delivered via nudge. The LLM no longer needs to choose between foreground and background — it just spawns and continues.

## User Stories

1. As an LLM, I want all Agent calls to return immediately, so I can continue working without blocking
2. As an LLM, I want agent results auto-delivered, so I don't need to poll or remember agent IDs
3. As a developer, I want a single spawn code path, so there's less duplication to maintain
4. As a developer, I want the `run_in_background` parameter removed from the tool schema, so the LLM has one fewer decision to make
5. As a user, I want the Agent widget to show all agents uniformly, so there's no visual distinction between foreground and background

## Implementation Decisions

**Remove `executeSpawnForeground`.** The function and its session-creation callback hack (`fgCallbacks.onSessionCreated` to capture agent ID) are eliminated. All spawns go through `executeSpawnBackground`.

**Remove `spawnAndWait` from AgentManager.** The method is `spawn()` + `await record.promise`. Without foreground agents, nothing calls it.

**Collapse the `runInBackground` branch in `executeAgentTool`.** The tool execute handler becomes: resolve type → spawn async → return started/queued message. One path.

**Remove `run_in_background` from the tool schema and agent briefing.** The parameter no longer affects behaviour. Remove from TypeBox schema, parameter description table, and usage guidelines in the agent briefing.

**Consolidate activity tracking.** `createActivityTracker` is called once per spawn (the background path). The foreground-specific `onSessionCreated` callback override and post-wait cleanup (`agentActivity.delete(fgId)`) are gone. Background cleanup in the nudge handler is the only path.

**Keep the nudge mechanism unchanged.** `emitIndividualNudge` already builds a stats line (tools · turns · tokens · duration) and delivers via `sendMessage({ deliverAs: "steer" })`. No change needed.

**Keep `resume` unchanged.** Resume is a separate code path that re-activates an existing session. Not affected by the foreground/background distinction.

**Update the Agent tool result rendering.** `renderResult` currently has two branches — rich stats card (foreground) and minimal card (background). Simplify to the minimal card. The nudge delivers the full result separately.

## Testing Decisions

- Test external behaviour only: spawn returns immediately, nudge delivers result, widget updates correctly
- Modules to test: `index.ts` (tool execute, renderResult), `agent-manager.ts` (spawnAndWait removed), activity tracking consolidation
- Prior art: `test/index.test.ts` has 134 tests covering tool registration, command handling, spawn callbacks, concurrency, config. Update foreground-specific tests to expect async behaviour.

## Known Constraints & Risks

**Nudge delivery is a different channel.** Results arrive via `sendMessage({ customType: "subagent-result", deliverAs: "steer" })` not as a tool result. All target models must handle steer messages identically to tool results. If a model ignores or deprioritises steer messages, agent results may be lost or delayed in the LLM's attention.

**Fast agents waste a turn.** A 2-second agent: spawn returns → LLM continues → nudge arrives → new turn. Foreground was one round-trip. For very fast agents this adds one extra turn cycle.

**No errorResult for spawn failures.** Foreground returned `errorResult()` (tool error signal). Background failure is a nudge with error icon — softer signal. The LLM may not treat a nudge error the same as a tool error.

**Cannot update the spawn card.** Tool result cards are immutable after render. The initial spawn shows a minimal card ("started in background"). The full result arrives as a separate nudge message. We cannot retroactively enrich the spawn card.

**`run_in_background` removal is a breaking change for the tool schema.** Any existing agent briefing or LLM memory that references the parameter will be stale. The `/agents` briefing command must be re-run after upgrade.

## Out of Scope

- Enriching the background spawn response with stats (deferred)
- Changing how the nudge mechanism works
- Changes to the resume path
- Changes to the steer functionality (already merged into running agents menu)

## Further Notes

The CONTEXT.md already defines the terminology consistently — "Nudge" is the completion notification, "Subagent" is the spawned agent. No terminology conflicts.

This is ADR-worthy: it's a deliberate deviation from the common pattern of offering both sync and async modes, hard to reverse (adding foreground back requires re-adding the branching logic), and surprising without context (why no blocking option?).
