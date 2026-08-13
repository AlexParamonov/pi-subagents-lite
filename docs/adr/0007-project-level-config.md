# Project-level config

A project can commit `.pi/subagents-lite.json` (same file name as the global
`~/.pi/agent/subagents-lite.json`) so every team member gets the same defaults.
At load the two files merge per field — project wins, global fills the rest,
hardcoded defaults fill the rest — and validation, clamping, and legacy-key
normalization apply to the merged result, not per file. `/agents` menu changes
persist to the project file when one exists, otherwise to the global file as
before. Three decisions:

## 1. Save writes a project-origin diff, not the full merged config

A menu save with a project file present writes only the keys the project file
already sets (updated to the merged value, or dropped when the key was deleted
from the merged config) plus keys whose merged value differs from the global
file. Defaults and global-only keys are never copied. Writing the full merged
snapshot was rejected: after the first menu change the project file would set
every field and silently shadow later global-file edits, eroding the "project
overrides only what it sets" contract the feature exists for. The diff is
recursive (concurrency `providers`/`models` merge per key at both nesting
levels) and deletion-aware (`clearModelOverride`, `removeProvider` drop the key
from the project file so it cannot resurrect on the next load). The raw files
are captured at load and diffed against, so a save reproduces the in-memory
session config exactly.

## 2. The merge lives in config-io, not the store

`createConfigIO(projectDir)` returns the existing `ConfigIO` port backed by two
files; `ConfigStore` stays untouched except for `setProjectDir()`, which
retargets the port at session_start (the store is constructed at module load,
before any cwd exists, so the project directory arrives at the `reload()` seam
in `loadConfigAndRegisterAgents`). Store-layer origin tracking was rejected:
the store would gain raw-config state and merge logic that already belongs next
to the default-merging IO code, for no behavioral gain.

## 3. The project file loads only in trusted projects

`loadConfigAndRegisterAgents` passes `.pi` only when `ctx.isProjectTrusted()`
is true, mirroring the existing `.pi/agents` scan-dir gate. This keeps the
documented cross-repo trust boundary honest (an untrusted spawn target's
`.pi/subagents-lite.json` must not change agent execution) and matches pi's own
model: `hasTrustRequiringProjectResources` does not include this file, so
projects without other `.pi` resources are auto-trusted and the feature works
unconditionally there. Unconditional loading was rejected: it would have loaded
repo-controlled config in projects the user explicitly chose not to trust, and
a repo-shipped file can change spawn behavior (`systemPromptMode`, model
overrides, watchdog timeouts).

## Why

Teams want shared agent defaults without each member hand-editing their global
file. The global file stays the personal base; the project file is a small,
hand-editable, committable diff on top.

## Trade-off

Save-time diffing adds logic to config-io, and a malformed project file is
treated as absent for the session (warned, saves go to the global file, the
malformed file is never overwritten). Mid-session hand-edits to either file are
picked up at the next reload, same as today.
