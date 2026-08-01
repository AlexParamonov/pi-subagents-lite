# Dev
**Package manager:** bun (`bun install`, `bun add`, `bun add -d`)
**Typecheck:** `bun run typecheck`
**Tests:** `bun run test` (vitest)
**Format:** `bun run format` (prettier) / `bun run format:check`

**Before committing:** run typecheck, tests, and format:check.

## Worktree path trust rule

The Agent tool's `worktree_path` accepts a path inside **any git repository on disk**, not only worktrees of the parent's repo. Same-repo paths are never gated. Cross-repo targets are gated by pi's trust framework using pi's exported building blocks only (`hasTrustRequiringProjectResources`, `ProjectTrustStore` nearest-ancestor lookup, `SettingsManager.getDefaultProjectTrust`) — never reimplemented, never reading `trust.json` directly. An undecided target falls back to the global `defaultProjectTrust` setting; anything other than "always" means untrusted. An untrusted target still spawns: its project resources are ignored, its `.pi/agents` types are not discovered, and a warning is surfaced. The `--approve`/`--no-approve` CLI flags and third-party `project_trust` extension handlers do not influence sub-agent trust resolution.
