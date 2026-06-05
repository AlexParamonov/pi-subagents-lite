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
