# Manual testing for `worktree_path` (wave 1)

Wave 1 ships a new `Agent` tool param. The wave's manual testing section
(`tasks/worktree-path-param/waves/1-deliver-worktree-path/wave.md`) is
LLM-driven ("prompt the parent LLM to spawn a subagent in /etc"). That makes
the tests non-deterministic — the LLM may decline, pass a different path, or
hallucinate.

This document records a more reliable approach, found while exploring how to
actually drive a pi TUI from this environment.

## The tmux driving pattern

There is no "pi tmux extension." The driving pattern is `tmux send-keys` for
input and `tmux capture-pane` for output, documented in
`~/code/pi/AGENTS.md` under "Testing pi Interactive Mode with tmux". tmux 3.4
is installed locally, which meets pi's >= 3.2 requirement.

```bash
tmux new-session -d -s pi-test -x 200 -y 50
tmux send-keys -t pi-test "cd /tmp/wt-test && pi" Enter
sleep 3 && tmux capture-pane -t pi-test -p -S -200   # full visible frame
tmux send-keys -t pi-test "spawn a subagent in /tmp/wt-feature" Enter
tmux send-keys -t pi-test C-o                        # toggle compact mode
sleep 1 && tmux capture-pane -t pi-test -p -S -200
tmux kill-session -t pi-test
```

`send-keys` accepts named keys (`Enter`, `Escape`, `C-o`, `C-c`, arrows).
`capture-pane -p` dumps the visible frame to stdout, which is greppable.

## Why use it

The TUI is what the user sees. The widget's full-vs-compact-mode behaviour,
the briefing text that lands in the parent, and the live redraw during a
parallel spawn are not testable through vitest alone — vitest covers the
renderer's input contract, not the visible output. tmux covers the visible
output without requiring a human at a keyboard.

## Caveats

- **`capture-pane` flicker.** Ink redraws incrementally; a captured frame
  may show partial state. Poll with a short sleep and pick the first snapshot
  matching an end-state marker (widget line visible, final assistant turn
  present, etc.). Capture with `-S -200` to get the full scrollback, not just
  the visible window. **Verified live**: `watch -n 0.2 date` redraws in place;
  two captures 300ms apart returned clean, distinct frames with no
  interleaved state.
- **LLM flakiness is the dominant failure mode.** Real API keys are present
  in this environment, but the model can decline to call the tool, pass a
  different path, or take a long detour. Use direct prompts copied verbatim
  from the wave's manual testing section. Hard timeout (~60s) per LLM step;
  on timeout, abort and report — do not retry blindly.
- **No `--provider faux` CLI flag.** The faux provider in
  `~/code/pi/packages/ai/src/providers/faux.ts` is for unit tests, not CLI
  driving. If a real LLM run is too flaky, register a custom stream function
  as a small extension under `examples/extensions/` (modeled on `faux.ts`,
  ~50 lines) and use it for the LLM-driven steps. Default to real keys.
- **The project lacks a `pi-test.sh`.** pi mono has one
  (`~/code/pi/pi-test.sh`); subagents-lite does not. Build a local wrapper
  that loads this project's extension (via `-e` or by symlinking into pi's
  extension path) and unset unused API keys. Verify once, then reuse.
- **Windows label normalization is not testable on this host.** Cover it
  with vitest using `path.win32` inputs to the label function; the renderer
  is cross-platform already.

## Test plan split

### Vitest (no TUI, fast, deterministic)

Covers the validator's rejection reasons, label computation, briefing string content, deletion-mid-run (via stubbed manager), worktree-local agent discovery, and the spawn menu's worktree picker (git-command integration mocked at the executor boundary). Maps 1:1 to the acceptance criteria in slices 1-1, 1-2, 1-3, and 1-4.

### tmux (real pi session, wave-level manual verification)

> **Slice-level testing is vitest-only.** This section is the wave-level manual verification checklist. The menu-driven tests for US-3, US-5, and US-6 require slice 1-4 (spawn menu worktree picker) to have shipped.

The fixture is the project itself. No synthetic `/tmp/test-repo` needed.

- **Parent worktree**: a dedicated worktree for wave 1
  (e.g., `issue/worktree-path`), created off `main`. The in-dev `src/`
  is loaded by passing `pi -e ./src/index.ts` when launching pi from
  inside it. Without `-e`, pi loads the installed copy of
  `pi-subagents-lite` (if any), not the in-dev `src/`.
- **Target worktree**: one of the existing worktrees in this repo
  (`add-widget-settings` or `break-circular-dep`). It is a real
  worktree of the parent's repo, shares `git-common-dir` with the
  parent, and is not the main checkout — so it passes the validator's
  acceptance criteria.

Worktrees available today:

```
/home/ap/code/pi-subagents-lite                                      6e6eba9 [main]
/home/ap/code/pi-subagents-lite/.git/buildtrees/add-widget-settings  0213747 [issue/add-widget-settings]
/home/ap/code/pi-subagents-lite/.git/buildtrees/break-circular-dep   41876fd [issue/break-circular-dep]
```

Dev loop: edit `src/` in the wave-1 worktree, `C-d` to exit pi,
relaunch `pi -e ./src/index.ts`, test. Without `-e`, pi's
auto-discovery scans `cwd/.pi/extensions/` (and the global extensions
dir), not the project's own `package.json` `pi.extensions` field —
so without `-e` pi loads the installed copy of `pi-subagents-lite`
(if any) instead of the in-dev `src/`. No build, no `pi install`.

`-e ./src/index.ts` is a manual-testing hack for loading WIP source
into a single pi session. No production code path uses it;
deployments go through `pi install` and pi's normal extension loader.

**Test sequence** (run after wave 1 is built):

1. Launch pi from the wave-1 worktree in a fresh tmux window. Capture
   the prompt; assert the loaded extensions list contains `src` and
   the status bar shows the worktree path and branch.
2. Run `/agents > Settings > Advanced > Diagnostics > Agent types`
   via `send-keys`. Capture and verify the expected agent catalog is
   available. Worktree parameter behavior is validated by the spawn
   flows below and by Vitest; the removed Agent briefing action is no
   longer part of the manual test path.
3. **US-6 (param omitted).** Open the spawn menu via `/agents >
   Spawn agent`. Leave the "Worktree" row at "Inherits parent cwd",
   enter a prompt that runs `sleep 5`, Spawn. Verify the widget shows
   the agent with no worktree label. Confirms the parent's-cwd path
   is preserved when the param is omitted.
4. **US-3, US-5 (parallel widget, distinct labels).** Open the spawn
   menu, pick `add-widget-settings`, enter a prompt that runs
   `sleep 20`, Spawn. Open the menu again, pick `break-circular-dep`,
   Spawn. Poll `capture-pane` over ~20s. Verify the widget shows two
   entries with distinct worktree labels. No LLM in the loop.
5. `send-keys C-o`. Capture. Assert labels absent (compact mode).
   `C-o` again. Assert labels return.
6. **US-1 (LLM spawns into a worktree).** Prompt the LLM: "Spawn a
   subagent in `<target-worktree-path>` that runs `sleep 5` and
   reports when done." Verify the widget shows the agent with the
   worktree label. Confirms the registered tool schema exposes the param.
7. **US-4 (worktree-local agent type).** Drop a
   `.pi/agents/feature-reviewer.md` into the target worktree with
   valid frontmatter. Prompt the LLM: "Use the `feature-reviewer`
   agent on this worktree." Assert the spawn succeeds.
8. **Validation rejections, deletion-mid-run, cross-platform label.**
   Covered by vitest (see the Vitest section above). No tmux step
   needed.

## What this plan does not do

- Hand-test from a keyboard. tmux + `send-keys` replaces that and is
  repeatable in CI.
- Babysit the LLM. Hard timeouts, then bail.
- Cover the widget in vitest beyond the renderer's input contract.

## What I got wrong

In an earlier draft of this plan I claimed I could not drive the TUI at all
and proposed relying on vitest + a subagent-based manual tester. The
documented tmux pattern was the obvious answer; I should have looked for it
on the first pass. Saved here so the next round does not repeat the miss.

## Live verification (2026-06-05)

I am running inside a pi session that is itself inside tmux. I used that
fact to test the pattern against a clean new window (`tmux new-window -n
tui-test`) without disturbing the user's other panes. Confirmed:

- `tmux send-keys -t %N "text" Enter` puts text into the target pane's TTY
  and the target process receives it. Verified with `cat` (echoed input
  twice — once as I sent it, once as the cat output).
- `tmux capture-pane -t %N -p -S -N` returns a clean, greppable snapshot.
  Even `python3 -i` running in the target pane produced clean frames.
- Special keys work: `C-c` interrupted `cat`, `C-d` exited python
  cleanly, `Escape` worked inside vim.
- `watch -n 0.2 date` (in-place redraw) produced two clean distinct frames
  300ms apart — no visible flicker / interleaved state.
- Alternate-screen TUIs work: launched `vim -u NONE test.txt`, sent
  `i` + `hello vim` + `Escape`, then `:q!`. The "hello vim" text appeared
  in the buffer, vim quit cleanly back to bash.

Cleanup was `tmux kill-window -t 0:tui-test` + `rm test.txt`. The other
panes (a separate pi in `%3`, two vim sessions) were not touched.

What I did **not** verify: driving a real pi session via this pattern.
The other pi pane (`%3`) is the user's active session — I will not
inject keys into it. Driving a freshly-spawned pi in a new window is the
obvious next step, but it costs an LLM call and a project load. Plan:
do that once, after the first slice lands, against a real fixture repo
in `/tmp`.

(Update: that step has now been done. See the next section.)

## Live verification with real pi (2026-06-05)

Follow-up test: launched the actual `pi` binary (v0.78.1) in a fresh
window without `-e`. The loaded extension was the installed copy of
`pi-subagents-lite`, not the in-dev `src/`. The extensions list
showed `src` because the installed package's `package.json` declares
`pi.extensions: ["./src/index.ts"]`, but that `src` is the installed
copy. (See the correction note in the Observations block below — the
correct dev loop uses `pi -e ./src/index.ts`.)

Sequence:
- `tmux new-window -n pi-hello-test`
- `cd /home/ap/code/pi-subagents-lite && pi` (5s wait for startup)
- `tmux send-keys "hello" Enter` (6s wait for response)
- `tmux send-keys C-o` (1s wait)
- `tmux send-keys C-o` (1s wait)
- `tmux send-keys "/exit" Enter` (then kill window)

Observations:
- Pi booted, loaded the installed `pi-subagents-lite` extension (not
  the in-dev `src/`), and was ready for input. The extensions list
  included `src` because the installed package's `package.json`
  declares `pi.extensions: ["./src/index.ts"]`, but that `src` is the
  installed copy, not the in-dev one. (Correction added later: the
  correct dev loop uses `pi -e ./src/index.ts` to force the in-dev
  extension. The harness details below — `tmux send-keys` and
  `capture-pane` — are valid; only the extension-loading explanation
  was wrong.)
- "hello" was sent, the LLM responded "Hey. What are we working on?"
  in the same frame, status bar updated with `↑906 ↓41 R3.4k 2.2%/200k`.
- `C-o` toggled the full keybinding reference on. Second `C-o` toggled
  it off. The compact/full transition is a screen-level change — single
  capture gives a stable frame in either state.
- `/exit` is **not a real pi command**. The LLM received it as a user
  message and replied "Goodbye." For teardown, use `C-c C-c` or `C-d`,
  or just `tmux kill-window` from the harness.
- Cleanup: `tmux kill-window -t 0:pi-hello-test`. Original panes
  intact.

This is the first end-to-end test of the pattern against the actual
target. The plan in this document now has empirical support, not just
analogy from simpler TUIs. The remaining gap is the `worktree_path`
feature itself, which is unimplemented — when slice 1-1 lands, the same
harness can drive the new param.

## Open issues raised by this test plan

### Conflicting subagents-lite extensions between parent and target

In the test scenario, the parent runs the in-dev `subagents-lite` from the
wave-1 worktree (vWave1), and the target worktree
(`add-widget-settings`) has v1.0.3 of the same extension auto-discovered
from its own `package.json`. When the subagent spawns into the target,
the worktree's local extension v1.0.3 is on disk and may be loaded.

The PRD's "Discovery flow" only specifies behaviour for *agent types*
(worktree's `.pi/agents/` is scanned) — not for extensions. The phrase
"extension discovery for the subagent is rooted at the worktree" leaves
the answer ambiguous:

- (a) Subagent inherits the parent's loaded extensions AND additionally
  does its own extension discovery in the worktree, on top. Result:
  two `subagents-lite` extensions visible to the subagent. Which one
  wins on a tool name collision?
- (b) Subagent inherits the parent's loaded extensions, with the
  worktree's discovery limited to skills/agent types only. Result:
  vWave1 only, worktree's v1.0.3 ignored. Cleanest, but contradicts
  the PRD's "extension discovery ... rooted at the worktree."
- (c) Subagent replaces its extensions with the worktree's set.
  Result: v1.0.3 only, vWave1 dropped. The subagent's session does not
  see the in-dev `worktree_path` tool. Surprising.

This is a real design gap, not just a test problem. The wave-1 slice
should pin down the answer (probably (b) for predictability, with a
note that worktree-local extensions are not yet supported) and the PRD
should be updated to match. Without this, the test scenario I just
described may behave unpredictably depending on which branch of the
implementation lands.

For the test itself, the practical impact is small: we are testing
the *parent's* `Agent` tool, not the subagent's tool set. The
parent's tool is fixed (whichever extension the parent's cwd
loaded). But the open question affects whether a subagent can itself
spawn further `worktree_path` subagents, and whether worktree-local
agent types can themselves be `worktree_path`-aware.

### Teardown: `/exit` is not a real pi command

Confirmed during live testing. The LLM receives `/exit` as a user
message and replies "Goodbye." The actual exit keys are `C-c C-c`
(empty prompt) or `C-d`. The harness should use those, or just
`tmux kill-window` from outside.

## Existing npm packages surveyed

Searched for "pi extension tmux" on npm. Three results, all different
problem from ours:

- **`@romansix/pi-tmux`** — manages a tmux session per project; tools
  `run`/`attach`/`peek`/`list`/`kill`/`mute`. For running dev servers in
  tmux windows next to pi. Not a TUI driver.
- **`@ogulcancelik/pi-tmux`** — pane management for pi; tools
  `run`/`read`/`send`/`stop`/`list`. Layout: "Pi runs on the left. The first
  worker pane splits to the right." Drives panes *next to* pi, not pi's
  own TUI.
- **`offline-ant/pi-tmux`** (GitHub, not on npm) — `tmux-bash`,
  `tmux-capture`, `tmux-send`, `tmux-kill`, `tmux-coding-agent`,
  `minitask`. Panes tagged by lock name. **This one is the most relevant
  adjacent tool**: `tmux-coding-agent` spawns a pi in a pane and `tmux-send`
  drives it. That is the agent-internal version of the bash pattern. Worth
  considering for the parent LLM in journey 3 (parallel worktree agents),
  but it is not a TUI test harness.

None of them drive pi's own TUI from a test harness. The problem shape is
different: we want to push keys into a running pi and read frames back. The
bash + `tmux` CLI pattern in `~/code/pi/AGENTS.md` is the right tool. If a
future need comes up to coordinate multiple pi instances in worktrees
*from within* the parent LLM, `offline-ant/pi-tmux` is the one to know
about.
