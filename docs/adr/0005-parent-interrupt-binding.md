# Foreground subagents under parent interrupts

Foreground Agent tool calls bind the spawned Subagent to the parent run's
interrupt signal, and the tool call blocks until the Subagent reaches a
terminal state. Four decisions:

## 1. Interrupt binding (foreground only)

When the parent run is interrupted — Esc during streaming or tool execution,
a stop/abort command, or session shutdown — every foreground Subagent spawned
by that run is stopped (`Stopped`, `stoppedBy: "user"`, partial output
preserved) or, if queued, cancelled before it starts. Background Subagents
(explicit `run_in_background` or `forceBackground`) are never bound and never
interrupted by the parent.

## Why

An interrupted parent turn has no consumer for its foreground results.
Previously a foreground Subagent kept running to completion after the
interrupt, spending tokens on work nobody awaits. Queued foreground Subagents
were worse: the tool call returned an empty result immediately and the
Subagent could start later as an orphan.

## Trade-off

Interrupting the parent now destroys in-flight foreground work instead of
letting it finish. That is the point — an interrupt is intent to stop — but
partial output is preserved in the record, so no completed work is lost.

## 2. Completion gate

Every Subagent record carries one completion gate, created at spawn and never
replaced. The gate opens exactly once when the record reaches a terminal
state (run settles, queued stop, start failure, already-aborted spawn, or
extension dispose). The foreground tool call blocks on the gate.

## Why

A foreground tool call must not return before the Subagent's outcome is
decided. The gate makes the wait uniform across every path: queued-then-run,
queued-then-cancelled, never-started, and normal completion all open the same
gate, so the parent always receives a real result — full output, partial
output plus a stopped note, or an error — never an early empty string.

## Trade-off

The tool call suspends the parent turn for the queue wait: a Subagent queued
behind a concurrency limit delays the parent LLM until a slot frees. The
existing watchdog bounds the worst case by stopping stuck blockers. The
alternative — returning immediately — produced empty results and orphaned
Subagents.

## 3. Queued stops notify

Stopping a queued Subagent (parent abort, StopAgent tool, widget stop)
notifies completion handlers, with a `Stopped` record. For background
Subagents this reaches the parent LLM as a `Stopped` nudge.

## Why

A queued Subagent has no run to settle, so its stop would otherwise be
invisible: the widget would not refresh and, for a background Subagent
stopped via StopAgent, the parent LLM would never learn the work was
cancelled. Notifying on every queued stop keeps one code path and one rule:
terminal transitions notify.

## Trade-off

A previously silent path now produces a parent nudge. The nudge is accurate
and informative, but it is an observable behavior change for StopAgent on
queued background Subagents.

## 4. Detach on settlement

The interrupt binding is removed when the Subagent settles, stops, fails to
start, is removed, or the manager disposes. A later abort of the parent
signal is then a no-op for that record.

## Why

The parent signal is per run and shared across all turns and tool calls, so
it can abort again after a Subagent has settled. Without detach, a later
interrupt would re-target settled records; with detach, settled results are
permanently settled. It also prevents listener leaks on removed records.

## Trade-off

Detach points must cover every terminal path (five sites). The cost is a
small hygiene invariant; the alternative — relying on `stopAgent` returning
`false` for terminal records — leaves stale listeners attached for the
signal's lifetime.
