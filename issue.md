## Parent

None - standalone feature.

## Wave

Wave: 1

## Role

implementation

## Type

AFK

## User Stories

- US-1: As a user, I want to configure the grace turns setting from the `/agents` menu so I can control how many extra turns an agent gets after hitting its turn limit.

## What to build

Add a "Grace turns" setting to the Model Settings menu, positioned after the "Force background" toggle. When selected, prompt the user for a number (minimum 0, no max) and persist it to the config file. The value replaces the hardcoded `GRACE_TURNS` constant in the agent runner, flowing through the config → tool-execution → agent-manager → agent-runner chain.

## Acceptance criteria

- [ ] "Grace turns · 6" appears in Model Settings menu after "Force background"
- [ ] Clicking it prompts for a number input with current value pre-filled
- [ ] Setting to 0 is allowed and persisted
- [ ] Setting to negative numbers is rejected with error notification
- [ ] Non-numeric input is rejected with error notification
- [ ] Value is saved to `~/.pi/agent/subagents-lite.json` under `agent.graceTurns`
- [ ] Value is read at spawn time and passed to agent-runner
- [ ] Agent-runner uses the config value instead of hardcoded `GRACE_TURNS = 5`
- [ ] Default value is 6 (when config field is absent or undefined)
- [ ] Type check passes: `bun run typecheck`
- [ ] Tests pass: `bun run test`

## Blocked by

None - can start immediately.

## Constraints

None - check PRD for feature-wide constraints.

## Definition of Done

- [ ] All acceptance criteria pass
- [ ] Tests pass: `bun run test`
- [ ] Type check passes: `bun run typecheck`
- [ ] No committed secrets or credentials
