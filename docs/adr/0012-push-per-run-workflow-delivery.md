# Push-per-run workflow delivery

Every Workflow run sends its full parsed Workflow file as `workflow_config` on
the create request (`POST /api/workflows`). The server holds no workflow
registry; the local `workflows/` folders are the single source of truth for
what exists.

## Why

The workflow API accepts a complete workflow config per run but has no
register or list endpoint, its only server-side fallback being one configured
default YAML path. A server-side registry would need a new API surface plus a
deployment/sync story. The extension already parses every local file at
discovery (the `Workflow` tool schema lists each file's `name`/`description`),
so sending the parsed config per run is one HTTP body and makes "what runs"
exactly "what's on disk".

The same reasoning places run context in the config we already own: the tool's
`path` param travels as an injected workflow-level `prompt_vars.working_dir`
entry rather than a new API field, and is interpolated server-side in prompt
text only (`${working_dir}`; prompt vars are deliberately invisible to param
resolution, and `context_messages` are never interpolated). The briefing
teaches prompt-text reach only.

## Trade-off

The definition is re-sent on every run — bytes on the wire, irrelevant at
hand-authored YAML scale — and a run keeps the config it started with even if
the file changes mid-run, which is the desired semantics. Do not "optimize"
the re-sending away later without introducing the registry this decision
rejects.

## Considered Options

- **Server-side registry with name-referenced runs** — rejected: no such API
  exists; adds deployment and drift machinery contradicting the stateless
  server.
- **Strategy-only requests** — rejected: the selected
  YAML never reaches the server; a fixed strategy runs regardless of what the
  user picked.
- **YAML text over the wire** — rejected: the API accepts objects only; local
  parsing is required anyway for discovery.
