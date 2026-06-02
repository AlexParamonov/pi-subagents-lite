## Parent

None

## Wave

Wave: 1

## Role

implementation

## Type

AFK

## User Stories

- US-1: As a user, I want to see the dollar cost of each subagent when it completes, so I can understand spending per agent.
- US-2: As a user, I want to see total agent cost in the status bar, so I can monitor my spend at a glance.
- US-3: As a user, I want to toggle cost display on/off, so I can customize my UI.

## What to build

Add cost display to subagent completion notifications and the footer status bar. When a subagent completes, its nudge notification and foreground result show `$X.XX` in the stats line. The status bar shows cumulative agent cost (e.g., `2 running agents · $0.008`). A toggle in the `/agents` menu lets users show/hide cost, stored as a session or permanent override like model settings.

## Acceptance criteria

- [ ] Nudge notification shows cost in stats line (e.g., `✓ Builder·2🛠 ·5⟳ ·12.3k·$0.008·10s`)
- [ ] Foreground result shows cost in stats line (same format)
- [ ] Status bar appends agent cost when > $0 (e.g., `2 running agents · $0.008`)
- [ ] Status bar shows only count when cost hidden or cost is $0
- [ ] `/agents` menu has "Cost display" option showing current state (ON/OFF)
- [ ] Toggling cost display updates immediately (no restart)
- [ ] Setting persists as session override or permanent (user chooses)
- [ ] Cost hidden when setting is OFF (nudge, result, and status bar)

## Blocked by

None - can start immediately

## Constraints

- Cost data comes from `AgentRecord.lifetimeUsage.cost` (already tracked)
- Status bar uses existing `setStatus("subagents", ...)` mechanism
- Storage follows same pattern as model/concurrency overrides (session vs permanent)
- `buildStatsLine` in index.ts is shared by foreground and nudge renderers
- Cost format: `$X.XX` (2 decimal places, e.g., `$0.01`, `$1.23`)

## Definition of Done

- [ ] All acceptance criteria pass
- [ ] Tests pass: `bun run test`
- [ ] Type check passes: `bun run typecheck`
- [ ] Build succeeds: `bun run build`
- [ ] No committed secrets or credentials
