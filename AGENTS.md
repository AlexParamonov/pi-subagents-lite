# Dev

**Package manager:** npm (`npm install`, `npm install <pkg>`, `npm install -D <pkg>`)
**Typecheck:** `npm run typecheck`
**Tests:** `npm run test` (vitest)
**Format:** `npm run format` (prettier) / `npm run format:check`

**Before committing:** run typecheck, tests, and format:check.

**Fixing test type errors:** replace `any` with real src/pi types (`vi.fn<RealSignature>()`, typed fixture factories, `Partial<T>` overrides). Use `interface` for object shapes, `type` for the rest. `expect.any(...)` is a vitest matcher, not an escape hatch. Boundary casts for pi-tui private members go in `test/pi-boundaries.ts`. Substitution ladder: real type > `unknown` + narrowing > documented `any` (last resort, reproduced failure required).

**Docs:** update CHANGELOG.md (Unreleased section).

## Pi
Pi source code in ../pi
