# Composition root over module-level shared state

Shared runtime state (config, session overrides, the activity store, the manager,
widget, pi instance, and session context) lives on a single composition-root
**shell** object that PI's fixed-signature callbacks capture by closure, rather
than as module-level mutable `let`/`Map` bindings exported from `state.ts`.
Per-session services (config store, agent manager, spawn coordinator, widget)
are constructed at `session_start` and mounted onto the shell; `session_shutdown`
disposes them. Owned domain state moves into the module that owns the concern:
config into the ConfigStore, the activity store and **Nudge** into the spawn
coordinator.

## Why

Three problems forced this. First, the PI runtime invokes tool `execute`
callbacks and event handlers (`tool_call`, `session_start`, `session_shutdown`)
as plain closures with signatures it dictates; they cannot take extra
parameters, so dependencies must be reachable from inside them somehow. A shell
captured by closure is the cleanest way and reaches every callback.

Second, `state.ts`'s own header warns that the PI runtime does not propagate
ESM live-binding reassignments, so `manager` and `widget` already use holder
objects rather than `let` re-exports. But `__config` *was* a `let` re-export
reassigned on every `setConfig()` — the exact stale-reference footgun the header
describes. A shell with fields removes live-binding reassignment entirely; the
closure always reads the current field.

Third, the module-level globals forced every test of a tool execute handler to
mock 15+ modules, because the handlers' real dependencies (config, manager,
pi, session context) were invisible in their signatures. Capture-by-closure
makes those dependencies real parameters of the handler (captured, not
positional), so a test substitutes one shell (or one service) instead of mocking
the world.

The shell is a composition root, not a god object: it is small (~the surviving
holder functions), survives across sessions, and owns nothing itself. Owned
domain state sits on the per-session services.

## Trade-off

Closures capture the shell at registration time (factory load), but the
per-session services are only populated at `session_start`. This reintroduces a
temporal coupling: a callback firing before the first `session_start` would see
unpopulated fields. In practice every callback that reads session services fires
during or after `session_start`, and `session_shutdown` disposes them, so the
shell fields are populated exactly when they're read. The contract is "callbacks
run inside a session" — true for all current handlers. It must be upheld when
adding new event handlers.

The shell is a process-local singleton for the lifetime of the extension. That's
acceptable here (one extension instance per pi process) but would be wrong in a
multi-instance setting. If pi ever ran multiple extension instances in one
process, the shell would need to become per-instance.

## Considered Options

- **Keep `state.ts` as a module-level singleton namespace.** Rejected: leaves
  the stale-`let` footgun for `__config`, keeps the 15-mock test pattern, and
  the "read directly, write via setter" contract stays an unenforced convention.
- **Per-handler dependency injection via a request-scoped context.** Rejected:
  PI's callback signatures don't accept extra parameters, so there is nowhere to
  inject per-call. Closure capture is the only injection mechanism available.
