# Short agent ids resolved by unambiguous prefix

Agent records are keyed by a 17-character id, but every id the model and the widget ever see is the 8-character short form. Rather than print full ids in tool output so the model can copy them back, we keep the short form everywhere and resolve tool input against it: `AgentManager.matchAgents(id)` returns the exact-key record when present, otherwise every retained record whose id starts with the input. One match acts, zero matches report "not found", and more than one reports ambiguity with the full candidate ids — the only place full ids are printed.

An ambiguous prefix resolves to nothing instead of picking the newest match: silently steering or stopping a different agent than the model named is worse than an error the model can correct. `getRecord()` stays exact-match for internal callers (widget, renderer, coordinator, watchdog), which already hold real keys — prefix resolution is a tool-input concern, not a manager-wide relaxation.

## Considered Options

- **Print full ids in LLM-facing text.** Rejected: the full id is paid for on every listing, nudge, and echo, while the short form is what the model actually quotes back.
- **Generate 8-character ids.** Rejected: trades a display convention for collision risk in the map key itself.
- **Resolve ambiguity to the most recent match.** Rejected: acts on an agent the model did not name.

## Consequences

- `AgentStatus` output, completion **Nudge** headers, and `StopAgent`'s echo stay short and remain usable as `agent_id` input.
- Resolution scans the retained records, so a prefix that is unique today can become ambiguous later as history accumulates; the ambiguity error then names both agents by full id.
- The failure lists printed by `StopAgent` (running and queued) and `MessageAgent` (bounded, settled included) are separate because stop and message have opposite preconditions.
