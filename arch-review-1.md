Status: BLOCK (harden-usage-extraction) / FLAG (split-menus-into-concern-modules)

Summary:
- 1 BLOCK issue (usage extraction: AC contradicts its own prototype).
- 9 FLAG issues across both issues (helpers misclassification, missing function placements, unspecified logging, behavior-change gaps).
- Key themes: internal inconsistency between AC and prototype, incomplete function inventory, missing constraint propagation from ADRs, unspecified observability (logging).

Scope note: Both issues are standalone (no wave/prd). Reviewed against CONTEXT.md, the four ADRs, and the actual source. Every claim below was verified against `src/` and `test/`.

---

# File: tasks/standalone/harden-usage-extraction/issue.md

## BLOCKER

### [BLOCK] AC and prototype contradict each other on the `as unknown as Record<string, unknown>` cast

Confidence: 95/100
**Location**: AC item "No `as unknown as Record<string, unknown>` casts remain in `agent-runner.ts` for usage extraction" vs. prototype signature `extractUsage(msg: Record<string, unknown>)`.
**Problem**: The call site (`src/agent-runner.ts:168-170`) is:
```ts
const msg = event.message as unknown as Record<string, unknown>;
const usage = usageFromAssistantMessage(msg);
if (usage) { options.onAssistantUsage?.(usage); }
```
`event.message` is typed (from `AgentSessionEvent`); passing it to a parameter typed `Record<string, unknown>` *requires* exactly the cast the AC forbids. The prototype's parameter type is too narrow to satisfy the AC.
**Why it matters**: A builder cannot satisfy both constraints. They will either keep the cast (violating AC) or widen the signature (violating the prototype). This is the kind of ambiguity that produces a wrong-first-pass implementation.
**Fix**: Pick one and make the issue self-consistent. Recommended: change the prototype to `extractUsage(msg: unknown): LifetimeUsage | undefined` and move *all* narrowing (including the `as unknown as Record<string, unknown>` and the `msg.usage` access) inside `extractUsage`. Then the call site becomes `const usage = extractUsage(event.message);` with no cast. This is also the cleaner design — the whole point of the type guard is to centralize the unsafe access.

---

## SHOULD-FIX

### [FLAG] Line 169 reference is wrong

Confidence: 95/100
**Location**: Constraints section: "agent-runner.ts call site at line 169 (`if (usage) { options.onAssistantUsage?.(usage) }`)".
**Problem**: Line 169 is actually `const usage = usageFromAssistantMessage(msg);`. The `if (usage) { ... }` guard is at line 170. Verified by direct read.
**Why it matters**: The constraint anchors on a wrong line number. A builder doing surgical edits will mis-locate the guard.
**Fix**: Either drop the line number (the constraint "guard logic must not change" is clear without it) or correct it to line 170.

### [FLAG] Warning logging mechanism unspecified; `usage.ts` has no logging precedent

Confidence: 85/100
**Location**: AC "logs a warning"; Constraint "Warning log must truncate payload to 200 chars".
**Problem**: The issue never says *how* to log. `src/usage.ts` is currently a pure module with zero logging — `getSessionContextPercent` swallows errors silently. It has no access to `ExtensionCommandContext`, so it cannot use the codebase's preferred `ctx.ui.notify(msg, "warning")` pattern (seen in `agent-runner.ts:274-276`, `menus.ts`, `spawn-wizard.ts`). The only available mechanism is `console.warn`, which is used elsewhere only for non-user-facing diagnostics (`config-io.ts:49` uses `console.error`).
**Why it matters**: Without a decision, the builder picks arbitrarily. If they use `console.warn`, the warning is invisible to end users (acceptable for a dev diagnostic, but the issue frames this as user-facing hardening). If they thread `ctx` into `usage.ts`, they violate the module's current purity and add a parameter to a function the prototype declares as taking only `msg`.
**Fix**: State explicitly: "Use `console.warn` with prefix `[pi-subagents]` — this is a developer diagnostic for upstream contract drift, not a user-facing notification. `usage.ts` stays ctx-free."

### [FLAG] Behavior change for "cost entirely absent" case is unspecified

Confidence: 80/100
**Location**: Prototype `UpstreamUsageShape { cost: { total: number } }` vs. current `usageFromAssistantMessage` at `src/agent-runner.ts:144`: `cost: ((usage.cost as Record<string, unknown>)?.total as number) ?? 0`.
**Problem**: Today, a message with `{ input, output, cacheWrite }` and **no `cost` field** returns a valid `LifetimeUsage` with `cost: 0`. The prototype's required shape makes absent-`cost` fail the type guard → warn + return `undefined` → caller skips the message entirely. The AC only addresses "cost present but cost.total missing"; it is silent on "cost absent".
**Why it matters**: This is a real behavior change that flips a previously-accepted message into a dropped one. If upstream ever omits `cost` on free/local turns, lifetime usage silently stops accumulating. The issue claims to "fail-open with warning" but this case fails *closed* (returns undefined → message skipped → accumulator misses a delta).
**Fix**: Add an explicit AC: either "(a) absent `cost` is treated as `cost: 0` and the guard accepts it" (preserve current behavior), or "(b) absent `cost` is malformed → warn + undefined" (documented behavior change). State which.

### [FLAG] Truncation target is ambiguous

Confidence: 75/100
**Location**: Constraint "Warning log must truncate payload to 200 chars".
**Problem**: "Payload" is undefined. Is it the whole `msg`, just `msg.usage`, or `JSON.stringify(...)` of one of those? A 200-char slice of `JSON.stringify(msg.usage)` is the likely intent, but the builder could reasonably truncate the raw object, the message envelope, or the stringified form.
**Why it matters**: Log volume and usefulness differ sharply. Truncating the full message envelope is nearly useless (the interesting part is in `.usage`); truncating `JSON.stringify(msg.usage)` is the useful form.
**Fix**: Specify: "`JSON.stringify(msg.usage).slice(0, 200)`".

### [FLAG] New tests have no designated home; existing tests are in the wrong file for the new structure

Confidence: 80/100
**Location**: AC "New tests cover valid shape, missing usage, malformed fields, missing cost.total".
**Problem**: `extractUsage` will live in `src/usage.ts`, so the natural home is `test/usage.test.ts`. But the *existing* usage-extraction tests live in `test/agent-runner.test.ts:398-546` and test through `subscribeToSessionEvents` (integration-style). The issue doesn't say whether to (a) leave those as integration tests and add unit tests to `usage.test.ts`, or (b) migrate them. It also doesn't reference the existing 6 test cases at `agent-runner.test.ts:398-546` that already cover valid/missing/zero-cost shapes — at least one of the "new" AC items ("valid shape") is *already* tested there.
**Why it matters**: A builder will either duplicate coverage or leave a coverage gap. They also won't know to check the existing tests for the behavior-preservation baseline.
**Fix**: Add: "Add unit tests for `extractUsage` to `test/usage.test.ts`. Leave `agent-runner.test.ts:398-546` (`subscribeToSessionEvents`) as integration coverage — it now exercises `extractUsage` through the call site and must still pass."

---

## NICE-TO-HAVE

### [FLAG] NaN and negative numbers pass `typeof === "number"`

Confidence: 70/100
**Location**: Prototype `isValidUpstreamUsage` comment: "typeof guards for input, output, cacheWrite, cost.total".
**Problem**: `typeof NaN === "number"` and `typeof -1 === "number"` both pass. A corrupted upstream field `{ input: NaN }` would produce a `LifetimeUsage` with `NaN`, poisoning the accumulator (`addUsage` would propagate NaN forever). Negative counts are nonsensical.
**Why it matters**: Cheap to guard, expensive to debug once NaN is in the accumulator.
**Fix**: Either add `Number.isFinite(x)` to the guard, or explicitly accept NaN/negatives as out-of-scope. State which.

### Note: `bun run typecheck` won't catch type errors in test code

Confidence: 90/100
**Location**: `tsconfig.json` has `"include": ["src/"]` and `"exclude": [..., "test"]`.
**Problem**: The DoD item "Type check passes: `bun run typecheck`" only validates `src/`. New tests in `test/usage.test.ts` are typechecked only at vitest runtime.
**Why it matters**: Not blocking — just don't rely on `typecheck` as the type-correctness gate for the new tests. Worth a one-line note in DoD.

---

# File: tasks/standalone/split-menus-into-concern-modules/issue.md

## BLOCKER

None. The issue is implementable as written; the concerns below produce a suboptimal split, not an incorrect one.

## SHOULD-FIX

### [FLAG] `menu-helpers.ts` mixes concern-specific helpers with genuinely shared helpers — split criterion is unstated and the proposed list violates it

Confidence: 90/100
**Location**: AC item listing `menu-helpers.ts` exports.
**Problem**: The issue's stated goal is "concern-aligned modules." But the helpers list includes functions that are **used by exactly one concern**, verified by call-site grep:

| Function | Callers | Genuinely shared? |
|---|---|---|
| `promptOverrideMode` (line 73) | only `showModelSettingsMenu` (252, 320) | **No** — model-settings |
| `applyModelOverride` (line 96) | only `showModelSettingsMenu` (268) | **No** — model-settings |
| `parseConcurrencyInput` (140) | only concurrency helpers (158, 176) | **No** — concurrency |
| `promptConcurrencyInput` (152) | only `showConcurrencySettingsMenu` (637, 666) | **No** — concurrency |
| `promptAddConcurrencyLimit` (171) | only `showConcurrencySettingsMenu` (710, 749) | **No** — concurrency |
| `runMenuLoop` (206) | 4 concerns (237, 516, 658, 768) | **Yes** ✓ |
| `parseNumericInput` (120) | spawn-wizard + menus | **Yes** ✓ |
| `promptModelSelection` (52) | spawn-wizard + menus | **Yes** ✓ |
| `matchMenuChoice` (424) | 3 menus (460, 490, 510) | **Yes** ✓ |

Five of the nine listed helpers are concern-specific. Following the AC literally produces a grab-bag `menu-helpers.ts` containing model-settings and concurrency logic — the exact opposite of "concern-aligned."
**Why it matters**: The stated goal and the AC conflict. A builder who follows the AC faithfully ships a worse split than the one they're refactoring away from. A builder who uses judgment deviates from the AC.
**Fix**: State the split criterion explicitly. Recommended rule: "`menu-helpers.ts` contains only functions called from ≥2 concern modules OR from `spawn-wizard.ts`. Concern-specific helpers (`promptOverrideMode`, `applyModelOverride`, `parseConcurrencyInput`, `promptConcurrencyInput`, `promptAddConcurrencyLimit`) stay private in their concern module." Then remove those five from the helpers AC and add them as private functions under `menu-model-settings.ts` / `menu-concurrency.ts`.

### [FLAG] `runMenu` (line 186) is shared but missing from the helpers list

Confidence: 85/100
**Location**: AC helpers list; `src/menus.ts:186`.
**Problem**: `runMenu` is called by `showConcurrencySettingsMenu` (via `editOrRemoveConcurrencyEntry:632`) and `showAgentActions` (940) — two different concerns. By the "shared helpers" criterion it belongs in `menu-helpers.ts`, but the AC doesn't list it. (It does list `runMenuLoop`, which is also shared.) Either both go to helpers, or both stay duplicated — but the AC is inconsistent.
**Why it matters**: Builder must guess. If they put `runMenu` in one concern module, the other concern either imports across concerns (layering smell) or duplicates it.
**Fix**: Add `runMenu` to the `menu-helpers.ts` export list (recommended), or explicitly state it stays as a private helper duplicated per concern (not recommended).

### [FLAG] Two private functions are unmentioned in any module's AC

Confidence: 90/100
**Location**: `src/menus.ts:623` (`editOrRemoveConcurrencyEntry`), `src/menus.ts:854` (`steerAgentById`).
**Problem**: Neither appears in any AC. Verified callers:
- `editOrRemoveConcurrencyEntry` → called only by `showConcurrencySettingsMenu` (692, 729). Natural home: `menu-concurrency.ts` (private).
- `steerAgentById` → called only by `showAgentActions` (919). Natural home: `menu-running-agents.ts` (private).

The AC lists entry-function exports per module but is silent on the ~9 private helpers (`buildModelOptions`, `editOrRemoveConcurrencyEntry`, `steerAgentById`, etc.). For a "pure refactor where all paths must work identically," every function needs a designated home.
**Why it matters**: Low risk for a competent builder (placement is inferable), but the AC reads as exhaustive when it isn't. Add a catch-all clause.
**Fix**: Add: "All unlisted private helpers move to the module of their sole caller as private functions. Functions called from multiple concerns go to `menu-helpers.ts`."

### [FLAG] Visibility expansion: AC exports functions that are currently private with no external caller

Confidence: 85/100
**Location**: AC items "menu-running-agents.ts exports `showResultViewer`", "menu-debug.ts exports `showDebugMenu`, `showAgentTypes`, `handleAgentBriefing`".
**Problem**: Today these are all private (`showResultViewer` 817, `showDebugMenu` 495, `showAgentTypes` 943, `handleAgentBriefing` 561). Only `showAgentActions` is currently exported (879). The test exercises `showResultViewer` *indirectly* through `showAgentActions` (`test/menus.test.ts:1225` describe block, dynamic import at 1251/1283/1315/1347) — it does not import `showResultViewer` directly. There is no external caller justifying the new exports.
**Why it matters**: Exporting functions without callers is surface-area expansion, which contradicts "pure refactor — no behavior changes." Either the issue intends these exports for testability (fine, but say so), or they're incidental (then keep them private).
**Fix**: Either (a) state "exports are for test access; tests import directly from the concern module," or (b) drop the non-entry-point functions from the export lists and keep them private. Pick one.

### [FLAG] Test import-path migration is implicit but breaking

Confidence: 85/100
**Location**: AC "All existing tests in `menus.test.ts` pass against the split modules (tests migrated to per-menu test files + shared `menu-test-helpers.ts`)". Existing dynamic imports at `test/menus.test.ts:1251, 1283, 1315, 1347`: `const { showAgentActions } = await import("../src/menus.js");`. Static import at `test/menus.test.ts:241`.
**Problem**: Per the dispatcher AC, `menus.ts` will export `showAgentsMainMenu`, `showSettingsMenu`, and re-export `showSpawnAgentMenu` — **not** `showAgentActions`. So every test that imports `showAgentActions`, `showModelSettingsMenu`, `showConcurrencySettingsMenu`, `showWidgetSettingsMenu` from `../src/menus.js` (line 241 static; line 1251+ dynamic) breaks. The AC says "tests migrated" but doesn't enumerate the import-path changes. The worktree briefing test at `test/menus.test.ts` (cross-referenced from `test/worktree-schema-briefing.test.ts:9`) is a protected invariant per ADR 0003 and must survive the migration verbatim.
**Why it matters**: A builder doing test migration needs to know (1) the import paths change, (2) which test file each block migrates to, and (3) that the worktree_path briefing content test is an invariant, not just "a test that should pass."
**Fix**: Add: "All test imports of menu functions change from `../src/menus.js` to the new per-concern module paths. `handleAgentBriefing`'s worktree_path content test (per ADR 0003) must be migrated verbatim to `menu-debug.test.ts` — briefing content is an invariant, not just behavior to preserve."

### [FLAG] ADR 0004 constraint not propagated: split modules must import shared state from `shell.ts`, not introduce module-level mutable state

Confidence: 80/100
**Location**: Constraints section; ADR 0004 (`docs/adr/0004-composition-root-over-shared-state.md`).
**Problem**: `src/menus.ts:27-31` imports `getPiInstance`, `getStore`, `getManager` from `shell.ts`. The split modules will need the same access. ADR 0004's central rule — "no module-level mutable `let`/`Map` bindings" — is not restated as a constraint. A builder could, e.g., cache a store reference at module load to save an import, reintroducing the exact footgun ADR 0004 eliminated.
**Why it matters**: Constraint drift. The ADR exists because this exact mistake was made before.
**Fix**: Add to Constraints: "Split modules continue to read shared runtime state via `shell.ts` accessors (`getPiInstance`, `getStore`, `getManager`). No module-level mutable state. Per ADR 0004."

## NICE-TO-HAVE

### [FLAG] Test file line count is off by one; "~80 lines" dispatcher target is unverifiable

Confidence: 90/100
**Location**: Constraint "Existing test file (2752 lines)"; AC "menus.ts is a thin dispatcher (~80 lines)".
**Problem**: `test/menus.test.ts` is 2751 lines (verified). The "~80 lines" target cannot be verified until the refactor lands — it's a prediction, not a constraint.
**Why it matters**: Trivial, but if an AC is going to cite numbers they should be checkable.
**Fix**: Drop the line counts or mark them as targets ("target: ≤100 lines").

### [FLAG] Test-file naming convention unspecified

Confidence: 70/100
**Location**: AC "tests migrated to per-menu test files + shared `menu-test-helpers.ts`".
**Problem**: The naming of the shared test helper module is given (`menu-test-helpers.ts`), but the per-menu test files are not. `menu-model-settings.test.ts`? `menus.model-settings.test.ts`? Convention matters for test-glob patterns.
**Fix**: Specify the pattern: "`menu-<concern>.test.ts`, e.g. `menu-model-settings.test.ts`, colocated in `test/`."

---

## Decisions

Checkable rules the issues should adopt before a builder starts:

**harden-usage-extraction:**
- `extractUsage` signature is `extractUsage(msg: unknown): LifetimeUsage | undefined` — all narrowing (including the `as unknown as Record<string, unknown>`) lives inside the function. Call site in `agent-runner.ts` has zero casts.
- Logging is `console.warn` with `[pi-subagents]` prefix. `usage.ts` stays `ctx`-free.
- Truncation target is `JSON.stringify(msg.usage).slice(0, 200)`.
- The "cost entirely absent" case has an explicit decision (treat as `cost: 0` to preserve current behavior, OR treat as malformed — pick one and add an AC).
- New unit tests go in `test/usage.test.ts`; existing `agent-runner.test.ts:398-546` stays as integration coverage.

**split-menus-into-concern-modules:**
- `menu-helpers.ts` contains only functions called from ≥2 concern modules or from `spawn-wizard.ts`. Concern-specific helpers stay private in their concern module.
- `runMenu` and `runMenuLoop` both go to `menu-helpers.ts`.
- Unlisted private helpers move to the module of their sole caller.
- Visibility expansion (exporting currently-private functions) is either (a) justified as "for test access" with tests importing from the concern module, or (b) dropped. Pick one.
- All test import paths change from `../src/menus.js` to per-concern module paths; the `handleAgentBriefing` worktree_path content test (ADR 0003) migrates verbatim.
- Split modules read shared state via `shell.ts` accessors only; no module-level mutable state (ADR 0004).

---

## Escalation

- The usage-extraction BLOCK (AC/prototype contradiction) is resolvable by the issue author with a one-line signature change — no architect decision needed. Recommend the issue author resolve it before assignment.
- The menus helpers-misclassification FLAG could become a BLOCK if the issue author insists on the literal AC list. Recommend they adopt the "shared helpers only" rule before assignment.
- No PRD/grilling assumptions found to be wrong. No cross-wave escalation needed (standalone issues).
