> **Status:** superseded by [ADR-0008](./0008-project-config-as-override-layer.md)

# Project-level config

A project can commit `.pi/subagents-lite.json` (same file name as the global
`~/.pi/agent/subagents-lite.json`) so every team member gets the same defaults.
When a valid project file exists, it is used as the **entire** config; the
global file is not consulted. When it does not exist (or is malformed), the
global file is used exactly as today. No merging between files, no diffs, no
tombstones: one file wins, wholly.

## Decision: a simple switch, not the v1 per-field merge

The first implementation (v1, in git history) merged the two files per field —
project wins, global fills, hardcoded defaults fill — with save-time diffing
and `null` tombstones for deletions, so a project file stayed a small diff on
top of the personal global file. The user rejected it as overly complex and
directed this simple switch:

- One file wins. A valid project file replaces the global file completely;
  global edits never apply to a project that has one. An empty project file
  (`{}`) is valid and means built-in defaults only.
- Saves write the full effective config to the file in use. A project file
  saved from the menus contains the full effective config, so it is
  self-contained and hand-editable.
- Validation, clamping, and legacy-key normalization apply to whichever file
  is loaded.

The merge design's rejected advantages: a small committable diff and the
ability to keep personal overrides alongside team defaults. That came at the
cost of a load-time merge with file-specific `null` semantics (inherit,
fall-back, delete depending on the key), save-time re-derivation of the diff,
and surprising interactions when the global file changed under a project.

## Load and save

`createConfigIO(projectDir)` returns the existing `ConfigIO` port backed by
one file in use: at `load()` it reads the project file when a valid one
exists, else the global file, and captures that file's path as the save
target. `ConfigStore` stays untouched except for `setProjectDir()`, which
retargets the port at session_start (the store is constructed at module load,
before any cwd exists, so the project directory arrives at the `reload()` seam
in `loadConfigAndRegisterAgents`). A malformed project file is treated as
absent for the session: warned, saves go to the global file, and the malformed
file is never overwritten.

## Trust gate

The project file loads only in trusted projects:
`loadConfigAndRegisterAgents` passes `.pi` only when `ctx.isProjectTrusted()`
is true, mirroring the existing `.pi/agents` scan-dir gate. This keeps the
documented cross-repo trust boundary honest (an untrusted spawn target's
`.pi/subagents-lite.json` must not change agent execution) and matches pi's
own model: `hasTrustRequiringProjectResources` does not include this file, so
projects without other `.pi` resources are auto-trusted and the feature works
unconditionally there. Unconditional loading was rejected: it would have
loaded repo-controlled config in projects the user explicitly chose not to
trust, and a repo-shipped file can change spawn behavior (`systemPromptMode`,
model overrides, watchdog timeouts).

## Why

Teams want shared agent defaults without each member hand-editing their
global file. The simple switch makes the project file self-contained: it is
the config for that project, period, and the menus behave identically for
both files.

## Trade-off

A project that commits `.pi/subagents-lite.json` fully owns its config: later
global-file edits no longer apply there, and the first menu save snapshots the
full effective config into the project file. That is the accepted cost of
killing the diff/tombstone machinery. Mid-session hand-edits to either file
are picked up at the next reload, same as today.
