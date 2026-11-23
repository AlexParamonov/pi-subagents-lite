# Dev

**Dependencies:** Vite+ (`vp install`, `vp install <pkg>`), with npm `11.9.0` pinned as its package-manager backend.
**Development Node:** Vite+ uses `.node-version` (`24`); its supported range is `^22.18.0 || ^24.11.0 || >=26.0.0`. The package runtime requirement remains documented in README.
**Toolchain:** Install the [global Vite+ CLI](https://viteplus.dev/guide/global-cli), then use `vp` commands; the project-local toolchain is pinned to `vite-plus@1.3.0`.
**Checks:** `vp check` (Oxlint, Oxfmt, and TypeScript type checks)
**Tests:** `vp test run` (Vitest through Vite+)
**Format:** `vp fmt` / `vp fmt --check` (Oxfmt)

**Before committing:** run `vp check` and `vp test run`.

**Fixing test type errors:** replace `any` with real src/pi types (`vi.fn<RealSignature>()`, typed fixture factories, `Partial<T>` overrides). Use `interface` for object shapes, `type` for the rest. `expect.any(...)` is a Vitest matcher, not an escape hatch. Boundary casts for pi-tui private members go in `test/pi-boundaries.ts`. Substitution ladder: real type > `unknown` + narrowing > documented `any` (last resort, reproduced failure required).

**Docs:** update CHANGELOG.md (Unreleased section).

## Pi
Pi source code in ../pi

## Lessons learned

## Testing

- A bare value as a `Promise.race` arm wins after one microtask hop: a race used to prove "still pending" is vacuous unless the fallback arm is a task-bounded promise that only settles when work is scheduled.
- When a new run path reuses callback wiring, mirror every first-run callback: a dropped `onTextDelta` silently breaks idle-watchdog feeding.
- When a run reuses a session's transcript, scope history-scanning to messages added during this run.
- Pin tool-argument keys against the dependency's actual tool schema, not local assumptions.
- For layout/order changes, assert the exact full item array and separator count, not membership.
- `Text.render()` pads every row out to the render width: trim each row before comparing rendered rows to an exact array.
- File-content test fixtures: malformed input as raw text, not a stringified value.
- Rendering tests: drive the public seam, not private methods.
- For a class with private members, mock at the real class's call boundary with one intersection cast.
- Replacing `: any` fixtures with real types: merge with `?? base` so absent overrides keep the base value.
- A lib-contract test via `vi.importActual` pins the input formats a fix claims to support.
- With `clockedLoopback`, a virtual clock step alone never delivers a socket response: await the endpoint's request arrival (`requestAt`) and step the clock at the cadence the client owes. `vi.waitFor` advances the fake clock in real time, so a 30s backoff ladder costs minutes of wall time.
- The extension reads `subagents-lite.json` as the session starts: a workflow test that writes the endpoint config after `session_start` talks to the developer's real `~/.pi/agent/subagents-lite.json` endpoint, not the loopback it scripted.
- `vi.fn(impl)` infers its generic from impl's return type — widen the mock's generic when tests replace returns with structurally-different fakes.
- Node builtin ESM namespaces reject `vi.spyOn` — fake partial imports instead.
- Schema library mocks produce mock-specific shapes — assert against the real library.

- New config setting: audit the full plumbing list in one pass (type, default, resolution/setter/sync, keys, internal defaults). A "setting survives clearAllModelOverrides" test belongs with every new setting.
- Config constraints: enforce at every entry point in one pass — enforcing two of three is a trap.
- `vi.fn()` at the call site infers `Mock<Procedure>`, but `ReturnType<typeof vi.fn>` resolves to the constraint. When a shared mock field gets swapped by consumers, annotate with `ReturnType<typeof vi.fn>`.
- A negative assertion must not forbid a word the same test pins: `not.toMatch(/stop/i)` can never pass on a note pinned as "nothing was stopped". Assert the protected claim instead - allow the honest denials, forbid the claim they deny.
- Pin model-facing text against the schema and channel that actually exist: with `additionalProperties: false` a note telling the model to pass `wait_for` points it at a validation error, and a run that already handed back has no tool call left to answer in.
- A row or card that reads the record paints the record's current state for any snapshot it is handed: to pin "before" and "after" a live change, capture the earlier rendered text before driving the change, and anchor the positive shape before the negative assertion so an empty row cannot pass it.
- Before pinning a state transition, read the wave criterion and the existing unit pin for the same transition. Two tests demanding opposite outcomes can be resolved only by deleting one, and an acceptance file is the wrong place to overrule a criterion. Where one input splits on who asked (aborted parent signal or not), pin both arms in adjacent tests.
- An exact-array render pin in an earlier wave's acceptance file is a shape contract, not a behaviour pin. When a later wave's committed test demands the row that surface now paints, re-point it in place - keep the unchanged rows as an array and pin the new row's own shape - rather than special-casing the surface to keep the old array.
- A test file that mocks the name registry to answer for every type (e.g. `getDisplayName` capitalising the type) cannot see production's unknown-type fallback. A name assertion in that file proves the renderer passed the field, never that the real registry names it.
- Pin "observation continued" on the channel the client really re-enters: after failed reads the last-known state is unknown, so no stream reopens until a `running` read restores it (ADR-0013) - count reads, not stream requests, and never make a reopened stream the evidence that monitoring survived.
- "The two copies differ" is a claim, not a fact: when de-forking a harness, run the swap. Handback's settlement waiter moved onto the real-clock `vi.waitFor` stayed green (`vi.waitFor` advances a fake clock, and the settling read is delivered before the wait), so that fork is clock ownership, not observed behaviour - while the same file's `waited`/`until` ladder is not interchangeable.
- A shared text read-back is pinned only as deep as its deepest assertion: truncating the `AgentStatus` listing to its first line stayed green because `notedRow` folds the row and the note's first line onto one physical line, so the note's routing line is unpinned on that surface.
- A field a test helper writes onto an object production handed it must exist in production: `widget.showStatus = true` outlived the property it once set, so the write was inert and the row it seemed to reveal came from elsewhere. Check the real object before believing a helper's setup.

## pi-ai API & Subagent Lifecycle

- `deliverAs: "steer"` only queues while parent runs — if idle, pi drops it silently. Check `ctx.isIdle()`.
- Pi may re-import extension modules with module caching disabled across cwd changes. Pass child-only parent capabilities through a `Symbol.for`-shared `AsyncLocalStorage` context, not a module-local spawn flag.
- `AgentSession.dispose()` does NOT emit `session_shutdown`; subagent `bindExtensions` DOES fire parent's `session_start`.
- A one-shot gate (consumed set) hides re-occurring events: continuations re-settle.

## Boundaries and Transitions

- Validate what the next component will actually act on, at every ingress: the assembled route, not an isolated piece, and every normalization layer it can pass through. Preserve omitted, declared-invalid and inadmissible values until the owning boundary decides. Name the guard's coverage limits where the guarantee is claimed.
- Put a side effect on the authoritative transition, never on a correlated value or a callback. Text equality is not turn identity, a frame or EOF is not a terminal outcome, a tool returning is not a run settling, and disposal is not the host's whole teardown. Prove it by holding the substitute triggers off.
- A renderer that must classify a value to stay safe is missing the answer field the contract already names; fix that before asking the producer for a new field, and keep a detail-level switch with the workflow's author.
- A home for data the model must not see has to be unreachable by the model and covered by redaction. A tool result's `details` is neither: Pi persists it verbatim and a `pi-messages` provider posts the transcript untouched. Leave such a value with its authoritative source.
- A test seam that degrades gracefully must be proven at the producer first: check the raw wire (SSE, loopback capture, `tool_execution_end.result`) before believing a live pass.

## SettingsList & Menus

- SettingsList: toggles, submenus, separators, static display. No multi-step dialogs. Never call `ctx.ui.input/select/custom` inside it.
- Submenu rows do NOT refresh their displayed value in place: wire `onRebuild` and trigger it from the `onChange`.
- Proxy pattern (`createDelegatingComponent`) chains submenus cleanly.
- Separator-skip lives in one shared helper: override `selectedIndex` on the list instance.
- When simulating library navigation in tests, initialize state exactly as the library class does.
- Per-entry override rows need a remove path wherever a set path exists.

## Buffer & Error Patterns

- `session.abort()`/`steer()` return promises fired from event listeners — always `void promise.catch(() => {})`. Mock sessions must be promise-shaped too.

## Package Management

- Regenerate lockfiles with the package manager when bumping versions; never hand-edit `package-lock.json`.
- Releasing: keep `[Unreleased]` as an empty running header; insert the versioned section below it.

## pi-tui Rendering

- ToolExecutionComponent renders in phases. AgentManager's `onStart` fires BEFORE pi's `tool_execution_start` — use pi's render lifecycle events, not callbacks.
- When the call renderer needs data not initially in `context.state`, use `toolCallId` to look up from the agent record.
