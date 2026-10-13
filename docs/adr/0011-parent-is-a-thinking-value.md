# `parent` is a thinking value, not a chain position

Upstream issue #29: a user who parks the parent session at `minimal` spawns a
Subagent and gets `high`, because with nothing configured the Subagent falls
through to pi's own `defaultThinkingLevel`.

`parent` is accepted as a **value** at every position that already holds a
Thinking level — the explicit spawn choice, frontmatter `thinking`, and
`defaultThinking` (global or project) — and resolves to the parent session's
current level at that position. It is not a new, lowest position in the chain.
Whichever position holds it decides, so an agent file's `parent` beats pi's
per-model entry and loses to the wizard's pick. When no parent level is
available, a source holding `parent` reads as unwritten and resolution
continues downward.

## Why

A lowest position would put pi's `defaultThinkingLevel` out of reach for
Subagents, and would force `off` on a non-reasoning parent (pi clamps upward, so
an inherited `minimal` can also land on `low`). As a value, `parent` keeps the
documented order intact: the only behaviour change is for configurations that
select it.

`defaultThinking` is already a model-family key, so the accepted value needs no
new layer plumbing: it stays project-allowed, is cleared by
`clearAllModelOverrides` like its siblings, and keeps its config key while only
the menu label changes to `Subagent default thinking`.

## Trade-off

`parent` is a sentinel inside a field otherwise typed as a level, so it must be
rejected before anything is handed to a child session or stored for display. The
resolver owns that boundary: it is the only place the value is expanded, and it
runs before the child session is created, so widgets, viewers and transcripts
only ever see a concrete level. The type that carries it is `ThinkingChoice`
(`ThinkingLevel | "parent"`), which keeps `ThinkingLevel` — the type used for
clamping and for pi's own settings — free of the sentinel.

Inheriting was not made the default: it would silently raise the effective cost
of every Subagent, remove pi's global default as a knob, and need a rule for a
non-reasoning parent. Opting in is one setting.
