# Dev
**Package manager:** bun (`bun install`, `bun add`, `bun add -d`)
**Typecheck:** `bun run typecheck`
**Tests:** `bun run test` (vitest)
**Before committing:** run both typecheck and tests.

## Branching
Before creating a feature branch, always run `git fetch origin --prune`, verify the current remote default branch, and branch from the fetched `origin/main` rather than a potentially stale local `main`.
