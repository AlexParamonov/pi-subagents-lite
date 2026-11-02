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

- When a new run path reuses callback wiring, mirror every first-run callback: a dropped `onTextDelta` silently breaks idle-watchdog feeding.
- When a run reuses a session's transcript, scope history-scanning to messages added during this run.
- Pin tool-argument keys against the dependency's actual tool schema, not local assumptions.
- For layout/order changes, assert the exact full item array and separator count, not membership.
- File-content test fixtures: malformed input as raw text, not a stringified value.
- Rendering tests: drive the public seam, not private methods.
- For a class with private members, mock at the real class's call boundary with one intersection cast.
- Replacing `: any` fixtures with real types: merge with `?? base` so absent overrides keep the base value.
- A lib-contract test via `vi.importActual` pins the input formats a fix claims to support.
- `vi.fn(impl)` infers its generic from impl's return type — widen the mock's generic when tests replace returns with structurally-different fakes.
- Node builtin ESM namespaces reject `vi.spyOn` — fake partial imports instead.
- Schema library mocks produce mock-specific shapes — assert against the real library.

- New config setting: audit the full plumbing list in one pass (type, default, resolution/setter/sync, keys, internal defaults). A "setting survives clearAllModelOverrides" test belongs with every new setting.
- Config constraints: enforce at every entry point in one pass — enforcing two of three is a trap.
- `vi.fn()` at the call site infers `Mock<Procedure>`, but `ReturnType<typeof vi.fn>` resolves to the constraint. When a shared mock field gets swapped by consumers, annotate with `ReturnType<typeof vi.fn>`.

## pi-ai API & Subagent Lifecycle

- `deliverAs: "steer"` only queues while parent runs — if idle, pi drops it silently. Check `ctx.isIdle()`.
- Pi may re-import extension modules with module caching disabled across cwd changes. Pass child-only parent capabilities through a `Symbol.for`-shared `AsyncLocalStorage` context, not a module-local spawn flag.
- `AgentSession.dispose()` does NOT emit `session_shutdown`; subagent `bindExtensions` DOES fire parent's `session_start`.
- A one-shot gate (consumed set) hides re-occurring events: continuations re-settle.

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
