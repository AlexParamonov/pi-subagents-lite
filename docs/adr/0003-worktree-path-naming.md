# Worktree path param naming

The `Agent` tool exposes a `worktree_path` parameter (a path inside a sibling git
worktree of the parent) rather than a generic `cwd` parameter. The schema name
encodes the validation constraint: the path must share `git-common-dir` with
the parent and must not be the main checkout.

## Why

The general "just add `cwd` and validate at runtime" approach lets the LLM
discover the constraint by hitting the validator and getting an error. In a
stealth-tool design (ADR 0001), the param name is the only documentation the
LLM sees at call time. The first rejected call costs a turn, plus the LLM has
to learn the rule from the error message.

`worktree_path` is more specific than `cwd` but cheaper than discovery-by-error:
the LLM reads "this is for worktrees" from the name, not from a failed spawn.

## Trade-off

The name is single-purpose. If a future feature needs the LLM to target any
directory (not just a worktree), the param is taken and a second param would
be needed. We accept this — the worktree framing is the use case we have, and
a future escape hatch (e.g. `cwd` as a separate, less-restricted param) is
cheap to add later.

Eleven extra characters in the schema per turn. Negligible token cost.

## Considered Options

- **`cwd`** — generic name, validator teaches the constraint on failure. Rejected:
  contradicts the stealth-tool principle that the schema name is the
  documentation. LLM pays a discovery turn per mistake.
- **`path_to_worktree`** — same semantic, more verbose. Rejected: no
  information gain over `worktree_path`; longer to type and to render.
- **`worktree_cwd`** — noun-stacked hybrid. Rejected: category mismatch;
  "worktree" is a path concept, "cwd" is a session concept, they don't compose.
- **`worktree_cwd`** — noun-stacked hybrid. Rejected: category mismatch;
  "worktree" is a path concept, "cwd" is a session concept, they don't compose.

## Amendment (2025): any git repository, gated by trust

The same-repo constraint is replaced by a trust gate (issue: allow-several-repos).
`worktree_path` now accepts a path inside **any git repository on disk** — the
parent's repo (any worktree or the main checkout, which was already accepted by
the validator), or a different repo entirely. The original "must not be the main
checkout" wording was inaccurate even before this change: the validator never
rejected the main checkout, and it stays accepted.

- The parent session is no longer required to be inside a git repository.
- A path outside any git repo is still rejected (`NOT_IN_GIT_REPO`).
- Same-repo targets are never gated. Cross-repo targets are gated by pi's
  existing trust framework: `hasTrustRequiringProjectResources` decides whether
  the gate applies; `ProjectTrustStore` nearest-ancestor lookup resolves a saved
  decision; an undecided target falls back to the global `defaultProjectTrust`
  setting, where anything other than "always" means untrusted. An untrusted
  target still spawns: its project resources are ignored, its `.pi/agents`
  types are not discovered, and a warning is surfaced.
- The `/agents` spawn wizard and its worktree picker are unchanged; they still
  list same-repo worktrees only.
- The param name stays `worktree_path`; no new parameter (a generic
  `working_directory` param remains explicitly out of scope).
