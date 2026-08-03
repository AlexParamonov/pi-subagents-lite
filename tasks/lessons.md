# Lessons Learned

## General

### Worktrees
- Clean up after merge first (commit/discard untracked files). Verify the worktree path, branch, and checkout state before spawning builder/reviewers.
- Read files through the worktree path, never the main checkout; verify `git status` after writing any file.
- Slice from feature branch HEAD, not main. Wave 2+ needs Wave 1 cleanup first.

### Testing
- Run `bun run test` after merging to main — a clean merge ≠ passing tests.
- Test public interfaces and behavior: acceptance tests match plan.md, not guessed implementation. Don't assert implementation details or the test's own setup — dead weight that passes even when the code under test is broken; prune imports they leave unused.
- Don't mock away the real path — assert constructor args, not just downstream behavior. Export testable functions early to avoid mock ceremony; interact through the component tree, not captured mock references.
- Re-read before multi-line replaces on code that shifted since the last read — stale ranges clobber adjacent signatures. A replace ending on the same line as the next surviving line flags boundary duplication; delete the stray duplicate before running tests.
- Replace `setTimeout` sleeps with awaiting the chained completion promise (`record.execution.promise`) — it resolves after `.finally`, so queue drain and side effects are guaranteed observed. Faster, no flake on slow CI.
- afterEach cleanup must remove the whole temp base dir, not one sibling — partial cleanup leaks on repeated runs.
- When AC review returns NEEDS_REVISION on recently fixed code, re-review fresh. Manual "all works" → record and proceed, don't insist on the automated loop.
- vitest mocks are strict: extending a vi.mock factory (e.g. adding an export) must keep every symbol the production module imports, or the whole file suite breaks with 'No X export on the mock'. Also guard config default merges with a loadConfig-level test — batch edits of literal default objects can silently drop adjacent lines (widgetMaxLines).
- `parseInt` accepts trailing garbage: validateNumeric("12x") === 12 and truncates "12.5" to 12, silently swallowing non-numeric input. Fix: require `/^\d+$/` after trim in numeric validation (review round on kill-stuck-agents), and pin it with tests that submit suffixed/decimal strings, not just "abc".

### Delegation
- Delegate immediately without pre-reading files — the agent explores itself. For simple tasks, propose 2-3 name/design alternatives upfront.
- Parallel sub-agents writing docs: mandate distinct output paths. Parallel slices (2+) consistently save time. Wave-level arch review catches incomplete feature branches.

### Verification
- Don't assume — verify: confirm the merge commit actually exists; code review catches silent production bugs.
- Never use `general-purpose` when the workflow specifies a specialized agent type.
- `ExtensionAPI` rejects calls to old ctx — wrap sendMessage in try-catch for defense-in-depth.

### Types & Refactoring
- Run typecheck before removing "redundant" fallbacks: `?? N` on optional config is forced by `T | undefined`; a cast before `??` on `unknown` is the narrowing (`unknown ?? T` stays `unknown`). Verify narrowing claims with the typechecker before simplifying casts.
- Make source fields optional from the start for explicit-vs-default overrides — the type system enforces precedence, not runtime equality checks. Trace ALL mutation paths of existing config when adding similar config.
- A result field whose check is implied by a sibling is dead weight: `gateApplied && !projectTrusted` ≡ `!projectTrusted`. Delete the flag, return the bare boolean, pin the guarantee through the surviving field.
- Check for WIP branches that might land before merging. Diff old paths before merging to preserve side effects.
- Only extract mock factories with ≥1 consumer in the current slice. Module-level singletons still require vi.mock().
- Prefer public API for cross-package access — private fields break silently on upstream changes.

### pi-ai API & Subagent Lifecycle
- `deliverAs: "steer"` only queues while the parent runs — if idle, pi drops it silently. `followUp` waits for the agent to finish. Check `ctx.isIdle()` at call time.
- `createAgentSession` runs its own resource reload + `bindExtensions`, re-executing EVERY extension factory and re-firing session_start/shutdown in the subagent context. Extensions writing parent-owned state there get clobbered per spawn (last wins, silent failures). Fix: bracket `runAgent` with a nesting-depth flag; no-op the factory and session handlers while a subagent is in flight.
- `AgentSession.dispose()` does NOT emit session_shutdown; subagent `bindExtensions` DOES fire the parent's session_start.

### Extension Tools
- When tools/resources are silently missing, find the gate first (where the set is built/filtered). Seeding happens at construction; `setActiveToolsByName` silently ignoring names = registry bug. Seed `createAgentSession({ tools })` with concrete names (expand `tavily/*` before creation). Verified in pi source: `agent-session.ts:_refreshToolRegistry`.
- The allowlist gate must derive from whitelist expansion alone in whitelist mode and gate builtins too — an unconditional `registeredTools` base leaks unlisted builtins and raw wildcard literals.
- Cross-repo trust gate coverage is narrower than it reads: `.pi/` resources + `.agents/skills` are gated via SettingsManager, but root `AGENTS.md`/`CLAUDE.md` load unconditionally through `loadProjectContextFiles({ cwd, agentDir })` (no trust param). SYSTEM.md is inert anyway — `systemPromptOverride` + `appendSystemPromptOverride: () => []` fully replace the loader's prompt. Subagent prompts are always subagents-lite's own build (replace/inherit/custom).

### SettingsList & Menus
- SettingsList: toggles, submenus, separators, static display. No multi-step dialogs, action buttons, or dynamic sets. Never call `ctx.ui.input/select/custom` inside it; dispatcher menus use `ctx.ui.select` + `while(true)` loop.
- Proxy pattern (`createDelegatingComponent`) chains submenus cleanly; verify the returned Component is renderable, not immediately closed. Use `.has()` presence checks for nullable caches.
- Use library helpers (`getSupportedThinkingLevels`, `clampThinkingLevel`) instead of reimplementing filtering. Submenu lazy evaluation works for dynamic option lists.

### Issue Design
- Prototype state machines/key handlers in issue.md as a contract; call out overflow behavior as a hard AC gate. Specify test location and approach ("test frontmatter parsing of max"). Single meaningful behavior test beats multiple implementation tests on a one-liner.
- Grill thoroughly — scope was corrected twice on allow-several-repos.

### Buffer & Error Patterns
- Buffer-then-flush is the simplest fix for ordering/corruption. Consider error paths when deferring side effects; try/finally guarantees flush.
- When nudges stop working, restart the harness rather than debugging live state.

### Package Management
- Regenerate lockfiles with the package manager when bumping versions; never hand-edit bun.lock.
- Releasing: keep `[Unreleased]` as an empty running header and insert the versioned section below it — don't rename it to the version.
- Keep `@ts-expect-error` focused — one error per directive.

### Cross-Platform
- `process.env.HOME` is unreliable on Windows — use `os.homedir()` or SDK's `getAgentDir()`.
- Check existing PRs for reference implementations before grilling alternatives (PR #12 already solved it).

### Refactor Scope
- Stay within issue scope — mock-pattern improvements are out of scope for a trust-gate issue.
- If a refactor hits a vitest ordering issue (vi.mock vs vi.hoisted), stop and move on — the code works.

## allow-several-repos - 2026-08-02
- **Worked:** grilling settled the design pre-issue (extension-only, trust-gate via pi's building blocks); builder verified SDK exports from node_modules; review feedback verified against code before applying; refactor stayed in scope; manual tester covered all 7 scenarios.
- **Failed:** three review rounds (ADR duplicate bullet, incomplete temp cleanup, stale test data, setTimeout pattern); misleading `worktreeDir` name from the same-repo-only era.
- **Next time:** name vars by current semantics, not historical ones. (Remainder already in General.)
## kill-stuck-agents - 2026-08-02
- **Worked:** research doc (file:line evidence) made the builder's job deterministic — event hooks, abort chain, config plumbing all pre-traced; pure clock-injectable Watchdog state machine kept the logic unit-testable without SDK mocks; reviewer caught the showCost interface deletion that typecheck silently swallowed via index signature; strict `/^\d+$/` numeric validation fixed a latent parse-int swallow across all menu items.
- **Failed:** orchestrator sequencing twice — spawned round-2 reviewer before the fix commit landed, and spawned AC reviewer before refactor/merge finished. Both stopped and respawned in order. Refactor pass 1 flake: wall-clock elapsed assertions failed (2760001 vs 2760000) — fixed with the file's established fake-timer pattern.
- **Next time:** keep review loops strictly sequential (fix commit → re-review → next step); verify agent completion order before spawning the next agent. Manual live-kill scenario untestable (LLM refused to run a deliberate hang) — automated coverage must carry the watchdog logic; note this in manual-test reports.
