# Lessons Learned

## General

### Worktrees
- Clean up after merge first. Verify worktree path, branch, and checkout state before spawning agents.
- Read files through the worktree path, never the main checkout. Verify `git status` after writing.
- Slice from feature branch HEAD, not main. Wave 2+ needs Wave 1 cleanup first.

### Testing
- Run `bun run test` after merging — clean merge ≠ passing tests.
- Test public interfaces and behavior matching plan.md. Don't assert implementation details; prune unused imports.
- Don't mock away the real path — assert constructor args, not just downstream behavior. Export testable functions early.
- Re-read before multi-line replaces on shifted code — stale ranges clobber adjacent signatures.
- Replace `setTimeout` sleeps with awaiting chained completion promises — faster, no flake.
- afterEach cleanup must remove the whole temp base dir, not one sibling.
- When AC review returns NEEDS_REVISION on recently fixed code, re-review fresh. Manual "all works" → record and proceed.
- vitest mocks are strict: extending a vi.mock factory must keep every symbol the production module imports. Guard config default merges with loadConfig-level tests.
- `parseInt` accepts trailing garbage. Fix: require `/^\d+$/` after trim in numeric validation.
- When two code paths must agree, share the exact computation — don't duplicate the rule with slight differences. Pin the contract as a state table.
- Config setter traps: check which getter the production path reads before choosing the setter in test setup.
- State consumed by render paths must be clamped at the render path, not only in mutators. Pin with tests that mutate state WITHOUT a nav move in between.
- Closure capture traps: a factory mock's closure binds its own parameter, so re-assigning the test's variable does nothing — assign explicitly against the outer variable.
- Recurring vacuous patterns to grep for: tests ending at `.find()` with no expect; global `some()` checks passing from initial state; `expect.any(String)` for branch-specific messages.

### Delegation
- Delegate immediately without pre-reading files. For simple tasks, propose 2-3 name/design alternatives upfront.
- Parallel sub-agents writing docs: mandate distinct output paths. Parallel slices (2+) consistently save time.

### Verification
- Don't assume — verify: confirm merge commits exist, code review catches silent production bugs.
- Never use `general-purpose` when the workflow specifies a specialized agent type.
- `ExtensionAPI` rejects calls to old ctx — wrap sendMessage in try-catch for defense-in-depth.
- Keep review loops strictly sequential; verify agent completion order before spawning the next agent.
- Verify agent output files exist before treating a return as verdict — an empty return with no file means restart, not approval.

### Types & Refactoring
- Run typecheck before removing "redundant" fallbacks. Verify narrowing claims with the typechecker.
- Make source fields optional from the start for explicit-vs-default overrides. Trace ALL mutation paths when adding similar config.
- Delete result fields whose check is implied by a sibling. Return the bare boolean.
- Check for WIP branches that might land before merging. Diff old paths before merging.
- Only extract mock factories with ≥1 consumer in the current slice. Module-level singletons still require vi.mock().
- Prefer public API for cross-package access — private fields break silently on upstream changes.
- After extracting a shared mock, prove each consumer reaches it: a mock is vacuous when the importing modules are themselves mocked. Run the file without it before keeping it.
- When a fix is about which arguments reach a function (e.g. `matchesKey(data, key)`), assert the call args — a mock implementation that ignores args keeps the old bug green.
- A lib-contract test via `vi.importActual` pins the input formats a delegation fix claims to support (legacy `\u000f` vs kitty/modifyOtherKeys `\x1b[111;5u`).
- Two mechanisms converging on the same state with the same gates are vestigial duplication: keep the one owned by the authoritative module (ConfigStore per ADR 0004), delete the other.

### pi-ai API & Subagent Lifecycle
- `deliverAs: "steer"` only queues while parent runs — if idle, pi drops it silently. `followUp` waits for agent to finish. Check `ctx.isIdle()` at call time.
- `createAgentSession` re-executes EVERY extension factory and re-fires session_start/shutdown in subagent context. Fix: bracket `runAgent` with nesting-depth flag; no-op factory and session handlers while subagent is in flight.
- `AgentSession.dispose()` does NOT emit session_shutdown; subagent `bindExtensions` DOES fire parent's session_start.

### Extension Tools
- When tools/resources are silently missing, find the gate first. Seed `createAgentSession({ tools })` with concrete names.
- Allowlist gate must derive from whitelist expansion alone in whitelist mode and gate builtins too.
- Cross-repo trust gate coverage is narrower than it reads: `.pi/` resources + `.agents/skills` are gated, but root `AGENTS.md`/`CLAUDE.md` load unconditionally.

### SettingsList & Menus
- SettingsList: toggles, submenus, separators, static display. No multi-step dialogs. Never call `ctx.ui.input/select/custom` inside it.
- Proxy pattern (`createDelegatingComponent`) chains submenus cleanly. Use `.has()` presence checks for nullable caches.
- Use library helpers instead of reimplementing filtering.

### Issue Design
- Prototype state machines/key handlers in issue.md as a contract. Call out overflow behavior as hard AC gate.

### Buffer & Error Patterns
- Buffer-then-flush is simplest fix for ordering/corruption. Consider error paths when deferring side effects; try/finally guarantees flush.
- When nudges stop working, restart the harness rather than debugging live state.

### Package Management
- Regenerate lockfiles with package manager when bumping versions; never hand-edit bun.lock.
- Releasing: keep `[Unreleased]` as empty running header, insert versioned section below it.

### Cross-Platform
- `process.env.HOME` is unreliable on Windows — use `os.homedir()` or SDK's `getAgentDir()`.
- Check existing PRs for reference implementations before grilling alternatives.

### Refactor Scope
- Stay within issue scope.
