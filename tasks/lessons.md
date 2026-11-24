# Lessons Learned

> Keep only reusable lessons that measurably improve future work.

## Ingest

Append new `## <name> (<detail>) - YYYY-MM-DD` entries; triage may regroup them.

## Evidence and tests

- Reproduce the reported input and surface verbatim before scoping a fix; inspect the real dependency/API path when its behaviour matters.
- Test through the public seam that produces the user-visible result. Read raw wire data or painted frames for claims about those surfaces.
- Pin behaviour, not copy, CSS, private methods, or fixture shape. Assert exact complete output when order or state matters.
- A test must distinguish the relevant cases: include boundary and near-miss values, multiple items for plural claims, and inputs that make competing sources disagree.
- Prove a guard is effective by mutating or removing it and checking the expected test fails. Green tests alone do not prove coverage.
- To prove a trigger, keep competing triggers inactive; to prove a transition, exercise both sides and the actual event order.
- Assert effects at their destination (drained queue, persisted transcript, painted frame), not an intermediate queue or returned value.
- Derive fixtures from production builders and platform behaviour. Handcraft only intentional edge shapes; keep mocks faithful to dependency edge cases.
- When changing a contract or presentation, grep all callers and committed pins, then update them in the same change. Verify dependency claims against source and declarations.
- Compare base and changed behaviour over the real input set before claiming a path is unchanged. Report mutation runs by their `FAIL` lines.
- For timing tests, await meaningful milestones instead of polling or advancing clocks before work is scheduled. Restore fake timers in `afterEach`.

## Boundaries, data, and lifecycle

- Validate the assembled value at the boundary that acts on it; preserve invalid, omitted, and explicitly declared values until that boundary decides.
- In layered config, invalid values must not collapse into absence and inherit a fallback. Enforce constraints at every entry point and warn only where the validating layer has evidence.
- Put guards on the authoritative state transition, not correlated text, callbacks, or a write that can later be bypassed. Derive context-dependent values at read time.
- Keep one effective guard per invariant and make it probeable. Before adding another guard, check whether an existing one already owns the invariant.
- Redact before truncating, normalize the secret and candidate text consistently, and inspect every output carrier. Keep untrusted text sanitized before terminal painting.
- Never index object-literal maps with external keys; use `Object.hasOwn`, `Map`, or explicit comparisons.
- Keep model-hidden data outside model-visible tool results and persisted transcript fields; `details` is persisted and is not private.
- Claim ownership before the first asynchronous operation that can outlive the caller. Release it on every settlement and synchronous setup failure; do not treat read failures as authoritative terminal states.
- Route all lifecycle triggers through one settlement path. Every end-of-connection trigger must resolve pending work, and cancellation tests should verify abort reaches the transport.
- Register teardown-visible state before callbacks or awaits can reach it. Declare callback state before the first `await`.
- A fire-and-forget promise still needs observable failure handling. Catch at event-listener boundaries and remove tracked work on either fulfillment or rejection.

## UI, rendering, and caches

- Derive a hit target from the frame actually painted; unrendered rows have no target. Test real input handlers and the rendered result.
- Treat each surface as its own contract. A sibling surface's test does not cover it; pin each state mapping where it is rendered.
- Carry presentation choices and produced rows through the layout plan instead of reclassifying later. Let the produced rows determine whether a section paints and where spacing belongs.
- Measure available width from the variable row's remaining space, using visible width rather than character count. Test wrapping and truncation at real render widths.
- Preserve platform formatter dispatch, constants, separators, and generic fallbacks from the dependency's actual implementation. Mirror them in one shared path and test both wrapped and untruncated output.
- Cache only stable work, at the grouping boundary that owns it. Cache keys must cover everything painted; pin invalidation and measure expensive calls on an unchanged frame.
- Work in an overlay's `render()` runs per frame; keep O(all text) work behind a correctly keyed cache.
- Identify which component owns row fill and colour before changing rendering. Pin theme roles, not escape bytes; padded rows need a recording theme rather than inline markers.
- Keep list state tied to live item identity when rows can change. Submenus need rebuild callbacks; SettingsList supports toggles, submenus, separators, and static display, not multi-step dialogs.
- A user-visible hint must use the resolved binding and disappear when unbound. Width fallback ladders must include a rung that renders nothing.

## Pi and dependency contracts

- Import `Type`/`TSchema` from host-owned `typebox` and `Check` from `typebox/value`; do not bundle `@sinclair/typebox`.
- Read the implementation behind dependency members, not just their declared type. Model fakes on real behaviour and verify important lifecycle contracts against a real session.
- `AgentSession.dispose()` does not emit `session_shutdown`; pi settles the active turn before shutdown. Pin those events separately to prevent duplicate stop or dead-session publication.
- `deliverAs: "steer"` queues work that Esc can clear and drops silently when idle. For durable busy-session notifications use `sendCustomMessage` with `triggerTurn: false` and no `deliverAs`; test the saved entry and next provider request with a real session.
- `sendMessage` is fire-and-forget: say “submitted” unless delivery is acknowledged. Temporary `turn_end` handlers should be removed after use because pi builds a session projection when handlers are present.
- `appendSystemPrompt` precedes later project context, skills, and cwd sections. Put tool-specific guidance in the tool description/schema, not conditional prompt text.
- `pi.registerTool` replaces by name and refreshes tools; it has no unregister operation. Tool toggles therefore require restart; pin registered names and schema changes.
- Reuse host-owned helpers and dependency exports only when their built declarations publish them. Keep shared mocks aligned with the real module surface (`vi.importActual` plus targeted overrides).
- In this project's tests, `pi.events` is a guarded facade; callbacks that wait on tracked promises must remove entries on both settlement outcomes.

## Project configuration and workflow

- A project file accepts model-family and per-type agent keys only; global-only keys must remain rejected.
- New settings require a full plumbing audit: type, default, resolution/setter/sync, keys, internal defaults, clear/reset behaviour, docs, and tests for absent versus explicit values.
- When adding a spawn entry point, route validation, trust checks, discovery, and warnings through the shared prelude. Accept `unknown` at shared ingress when callers are untrusted.
- A `vi.mock` factory that hand-lists exports duplicates the module contract. Spread the real module and override only needed stubs; search old names on renames.
