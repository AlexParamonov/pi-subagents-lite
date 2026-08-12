# Settled-agent retention

Terminal Subagent records (completed, turn_limited, aborted, stopped, error)
are never removed by a timer. They persist until the user clears them from the
`/agents` menu or the extension disposes. The widget hides finished rows after
the `finishedRetentionMinutes` window; the manager-side eviction timer and the
widget's turn-based eviction are removed. Two decisions:

## 1. Records persist until cleared or session end

The `/agents` menu is the management surface for Subagent records. The previous
design evicted terminal records about a minute after completion (default
`finishedRetentionMinutes: 1`), so a finished agent's result and status became
unreachable after that window, and no action existed to dismiss a record at all
— eviction was the only removal path. Keeping records until cleared makes the
menu a reliable record of the session, and makes the background-nudge ordering
invariant (a record must survive until its nudge is emitted) trivially
satisfied: no timer can remove a record mid-batch.

## Why

Users inspect finished agents minutes or hours after completion — results,
errors, and status are exactly what the menu is for. Eviction by timer made
that inspection time-boxed and removed the only dismissal path along with it.

## Trade-off

Memory: records and their sessions (message history, required by the menu's
"View conversation" for finished agents) persist until cleared or session end
instead of being freed after a minute. Bounded by session length; `dispose()`
still tears everything down. Long sessions grow the menu list — acceptable for
a management surface.

## 2. One time-based widget filter replaces two eviction mechanisms

The widget previously evicted finished rows by turn count
(`finishedEvictTurns`, default 4, with extra linger turns for error/stopped
statuses) while the manager evicted by wall-clock time — two retention
mechanisms with different units, surfaces, and configs. The widget now uses
one time-based window (`finishedRetentionMinutes` after `completedAt`),
uniform across statuses.

## Why

Time is the natural unit for "how long after completion should this stay
visible" — it matches how users think about finished work. Turn counting tied
visibility to parent activity in a way that is hard to reason about: four
turns is seconds or minutes depending on turn length. One mechanism, one
config, one mental model; uniform across statuses because the menu retains
everything anyway.

## Trade-off

`finishedEvictTurns` disappears — a user-visible setting is removed; legacy
configs carrying it are ignored by normalization. The widget's window behavior
now depends on the widget's render timer rather than the manager's cleanup
tick, so a live window change (config edit) applies on the next render.
