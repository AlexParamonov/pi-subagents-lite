/**
 * menu-spawn-wizard.ts — Spawn agent wizard and worktree picker.
 *
 * Extracted from menus.ts to own the multi-step spawn composition flow:
 * type selection → prompt → options sub-menu → spawn.
 *
 * The worktree picker (listWorktrees, isInGitRepo, parseWorktreeList, truncatePath)
 * is co-located here because it exists solely to feed the spawn wizard's worktree_path.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, SelectList, type SettingItem } from "@earendil-works/pi-tui";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "../../types.ts";
import type { Theme } from "../types.ts";
import { getAgentConfig, getAvailableTypes, discoverNewAgents } from "../../agents/agent-types.ts";
import { findModelInRegistry } from "../../utils.ts";
import { agentBulletPrefix } from "../format.ts";
import {
  clampThinkingToModel,
  formatDisplayedThinking,
  PARENT_THINKING_CHOICE,
  PI_DEFAULT_CHOICE,
  resolveDisplayedThinking,
  THINKING_CHOICE_TAIL,
  type DisplayedThinking,
} from "../../models/thinking-resolution.ts";
import { getPiDefaultThinkingLevel, getPiModelThinkingLevels } from "../../pi-settings.ts";
import { SEPARATOR_ID, buildSettingsListTheme, buildSelectListTheme, createSearchableSelect } from "./helpers.ts";
import { DEFAULT_GRACE_TURNS } from "../../config/config-io.ts";
import { createModelSelectSubmenu } from "./submenus/model-select.ts";
import { createNumericSubmenu, createInputSubmenu } from "./submenus/numeric-input.ts";
import { SettingsListWrapper } from "./wrappers/settings-list.ts";
import { getPiInstance, getSessionCtx, getWidget, getStore, getCoordinator } from "../../shell.ts";

// --- Worktree picker helpers ---

const WORKTREE_LIST_TIMEOUT_MS = 5000;

const WORKTREE_PATH_TRUNCATE_LEN = 60;

interface WorktreeEntry {
  path: string;
  branch: string | null;
  isDetached: boolean;
}

/**
 * Parse `git worktree list --porcelain` output into structured entries.
 *
 * Format (one block per worktree, separated by blank lines):
 *   worktree /path/to/worktree
 *   HEAD <sha>
 *   branch refs/heads/<name>   (or: (detached))
 */
function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  const blocks = output.split(/\n\n+/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    let path = "";
    let branch: string | null = null;
    let isDetached = false;
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length);
      } else if (line.startsWith("branch refs/heads/")) {
        branch = line.slice("branch refs/heads/".length);
      } else if (line === "detached") {
        isDetached = true;
      }
    }
    if (path) {
      entries.push({ path, branch, isDetached });
    }
  }
  return entries;
}

function truncatePath(p: string): string {
  if (p.length <= WORKTREE_PATH_TRUNCATE_LEN) return p;
  return "..." + p.slice(p.length - WORKTREE_PATH_TRUNCATE_LEN + 3);
}

/**
 * Fetch worktrees via `git worktree list --porcelain`.
 * Returns null if git is unavailable or the command fails.
 */
async function listWorktrees(cwd: string): Promise<WorktreeEntry[] | null> {
  try {
    const result = await getPiInstance().exec("git", ["worktree", "list", "--porcelain"], {
      cwd,
      timeout: WORKTREE_LIST_TIMEOUT_MS,
    });
    if (result.code !== 0) return null;
    return parseWorktreeList(result.stdout);
  } catch {
    return null;
  }
}

/**
 * Check whether a directory is inside a git repository.
 * Uses `git rev-parse --git-common-dir` — the same strategy as the worktree validator.
 */
async function isInGitRepo(cwd: string): Promise<boolean> {
  try {
    const result = await getPiInstance().exec("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      timeout: WORKTREE_LIST_TIMEOUT_MS,
    });
    return result.code === 0 && result.stdout.trim() !== "";
  } catch {
    return false;
  }
}

// --- Spawn agent wizard ---

/**
 * Build the thinking-level submenu for the model a spawn would use, resolved
 * through `resolveModel` when the picker opens: its supported levels, then
 * `parent` and `pi default`. A non-reasoning model lists only `off` as a level,
 * since every level clamps to `off` there; the tail stays offered whatever the
 * model supports, so any earlier pick can be reversed.
 */
function createThinkingLevelSubmenu(
  resolveModel: () => Model<any> | undefined,
  theme: Theme,
  onThinkingChoice: (choice: string) => void,
): (_currentValue: string, done: (v?: string) => void) => any {
  return (_currentValue, done) => {
    const model = resolveModel();
    if (!model) {
      done();
      return {} as any;
    }

    const supported = getSupportedThinkingLevels(model);
    const isReasoning = model.reasoning;

    const items: Array<{ value: string; label: string; description?: string }> = supported.map((level) => ({
      value: level,
      label: level === "off" ? "Off" : level.charAt(0).toUpperCase() + level.slice(1),
      description: !isReasoning ? "(not supported by this model)" : undefined,
    }));

    items.push(...THINKING_CHOICE_TAIL.map((choice) => ({ value: choice, label: choice })));

    const list = new SelectList(items, 10, buildSelectListTheme(theme));
    list.onSelect = (item) => {
      onThinkingChoice(item.value);
      done(item.value);
    };
    list.onCancel = () => done();

    return list;
  };
}

/**
 * Show the spawn agent flow as a multi-step wizard:
 *   Step 1: type selection (SelectList)
 *   Step 2: prompt entry (Input)
 *   Step 3: options sub-menu with spawn (SettingsList with submenus)
 */
export async function showSpawnAgentMenu(ctx: ExtensionCommandContext, modelOptions: string[]): Promise<void> {
  // ---- Step 1: Type selection ----
  let selectedType: string;
  {
    const types = getAvailableTypes();
    if (types.length === 0) {
      ctx.ui.notify("No agent types available", "error");
      return;
    }

    const result = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
      const items: SettingItem[] = types.map((t) => ({
        id: t,
        label: `${agentBulletPrefix(t)}${t}`,
        currentValue: t,
        description: getAgentConfig(t)?.description ?? "Agent type",
        submenu: (_v: string, _subDone: (value?: string) => void) => {
          done(t);
          return undefined as any;
        },
      }));
      const list = new SettingsList(
        items,
        10,
        buildSettingsListTheme(theme),
        (_id, value) => {
          done(value);
        },
        () => done(undefined),
        { enableSearch: true },
      );
      return new SettingsListWrapper(list, { title: "Select Agent Type", theme, passthroughKeys: true });
    });
    if (result === undefined) return;

    const config = getAgentConfig(result);
    if (!config) {
      ctx.ui.notify(`Unknown agent type: ${result}`, "error");
      return;
    }
    selectedType = result;
  }

  const agentConfig = getAgentConfig(selectedType)!;

  // ---- Step 2: Prompt entry ----
  let prompt: string;
  {
    const result = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
      const input = createInputSubmenu(ctx, { required: true })("", done);
      return new SettingsListWrapper(input, { title: "Agent Prompt", theme, passthroughKeys: true });
    });
    if (result === undefined) return;
    prompt = result;
  }

  // ---- Step 3: Options sub-menu with spawn ----
  const session = getSessionCtx();
  const parentCwd = session?.cwd ?? "";
  const inGitRepo = parentCwd ? await isInGitRepo(parentCwd) : false;
  const worktrees = inGitRepo ? ((await listWorktrees(parentCwd)) ?? []) : [];

  const store = getStore();
  const parentModelId = session?.model ? `${session.model.provider}/${session.model.id}` : "";
  const effectiveModelStr = store.modelFor(selectedType, parentModelId, agentConfig);

  let currentModelStr = effectiveModelStr || "";

  // Thinking states, each named by the picker entry that sets it. `default`
  // sends no explicit value so the chain decides at the spawn's target cwd; the
  // other two pin one, `following` re-read from the parent session per rebuild.
  type WizardThinking = { kind: "default" } | { kind: "picked"; level: ThinkingLevel } | { kind: "following" };
  let thinkingState: WizardThinking = { kind: "default" };

  /** Record the user's pick from the thinking submenu. */
  const setThinkingChoice = (choice: string) => {
    if (choice === PI_DEFAULT_CHOICE) thinkingState = { kind: "default" };
    else if (choice === PARENT_THINKING_CHOICE) thinkingState = { kind: "following" };
    else thinkingState = { kind: "picked", level: choice as ThinkingLevel };
  };

  /** The wizard's default spawn target: the parent session's cwd. */
  const parentThinkingCwd = session?.cwd ?? ctx.cwd;
  // Pi settings snapshot for the thinking display, read at the spawn's target
  // cwd. A prediction for display only — the session is the source of truth
  // once it exists. Re-read on every target change, so the `default` state's
  // prediction always describes the cwd the spawn would resolve in.
  let modelThinkingLevels = getPiModelThinkingLevels(parentThinkingCwd);
  let piDefaultThinking = getPiDefaultThinkingLevel(parentThinkingCwd);

  /** Re-read the pi settings snapshot for a new spawn target cwd. */
  const refreshThinkingSnapshot = (cwd: string) => {
    modelThinkingLevels = getPiModelThinkingLevels(cwd);
    piDefaultThinking = getPiDefaultThinkingLevel(cwd);
  };

  /**
   * The model a spawn would use: the wizard's pick, or, when it sends no model,
   * the chain `agent-runner.initSession` walks for an omitted one — the agent
   * file's model first, then the parent session's.
   */
  const currentModel = () =>
    findModelInRegistry(
      currentModelStr || agentConfig.model,
      session?.modelRegistry ?? ctx.modelRegistry,
      session?.model,
    );

  /** pi's per-model entry for the model a spawn would use. */
  const perModelThinking = (): ThinkingLevel | undefined => {
    const model = currentModel();
    return model ? modelThinkingLevels[`${model.provider}/${model.id}`] : undefined;
  };

  /**
   * The parent session's live level, clamped to the model a spawn would use.
   * Read from the extension context, the source every runtime resolution of
   * `parent` uses; a stored session context can lag behind it.
   */
  const followedThinking = (): ThinkingLevel | undefined => {
    const level = ctx.thinkingLevel;
    if (!level) return undefined;
    return clampThinkingToModel(currentModel(), level);
  };

  /** The chain prediction for the model a spawn would use, clamped to it. */
  const derivedThinking = (): DisplayedThinking =>
    resolveDisplayedThinking(
      {
        frontmatter: agentConfig.thinkingLevel,
        perModel: perModelThinking(),
        defaultThinking: store.agent.defaultThinking,
        parentLevel: ctx.thinkingLevel,
      },
      piDefaultThinking,
      currentModel(),
    );

  /**
   * The level the spawn sends as its explicit param, clamped to the model a
   * spawn would use. Read per rebuild, so a model change re-clamps without the
   * state storing a model-specific level. On `default` nothing is sent: the
   * derived value is only a display prediction read at the parent cwd, and
   * passing it would shadow the spawn target's own per-model entry (worktree
   * targets carry their own .pi/settings.json), so the runner resolves
   * frontmatter, per-model and defaultThinking at the actual target cwd.
   */
  const spawnThinkingLevel = (): ThinkingLevel | undefined => {
    if (thinkingState.kind === "picked") return clampThinkingToModel(currentModel(), thinkingState.level);
    if (thinkingState.kind === "following") return followedThinking();
    return undefined;
  };

  /** What the thinking row shows: the level the spawn sends, annotated unless the user picked it. */
  const thinkingDisplay = (): string => {
    const level = spawnThinkingLevel();
    if (level) {
      return thinkingState.kind === "picked" ? level : formatDisplayedThinking({ level, source: "parent" });
    }
    // `default`, and `following` with no parent level to pin: the row reports
    // what the chain decides, which is what the spawn then runs.
    return formatDisplayedThinking(derivedThinking());
  };

  let currentMaxTurns: number | undefined = agentConfig.maxTurns ?? store.agent.defaultMaxTurns;
  let currentMaxTokens: number | undefined = agentConfig.maxTokens;
  let currentGraceTurns: number = store.agent.graceTurns ?? DEFAULT_GRACE_TURNS;
  let currentBackground: boolean = true;
  let currentWorktreePath: string | undefined;
  let currentWorktreeLabel = "Inherits parent cwd";
  let currentDescription = prompt.length > 50 ? prompt.slice(0, 50) : prompt;

  const buildItems = (): SettingItem[] => {
    const fmtNum = (v: number | undefined) => (v != null ? String(v) : "(not set)");
    const displayModel = currentModelStr || "(inherits parent)";
    const items: SettingItem[] = [
      {
        id: "spawn",
        label: "Spawn",
        currentValue: "",
        description: "Spawn the agent with current settings",
        submenu: (_v, done) => {
          const gtItem = items.find((i) => i.id === "graceTurns");
          const bgItem = items.find((i) => i.id === "background");
          const descItem = items.find((i) => i.id === "description");
          const promptItem = items.find((i) => i.id === "prompt");

          const thinking = spawnThinkingLevel();
          const maxTurns = currentMaxTurns;
          const maxTokens = currentMaxTokens;
          const graceTurns = Number(gtItem?.currentValue ?? DEFAULT_GRACE_TURNS);
          const background = bgItem?.currentValue === "ON";
          const description = descItem?.currentValue ?? currentDescription;
          const spawnPrompt = promptItem?.currentValue ?? prompt;

          // Resolve model
          let model: ReturnType<typeof findModelInRegistry> = undefined;
          let modelKey: string | undefined;
          if (currentModelStr) {
            const registry = session?.modelRegistry ?? ctx.modelRegistry;
            model = findModelInRegistry(currentModelStr, registry, undefined);
            if (!model) {
              ctx.ui.notify(`Model not found: ${currentModelStr}`, "error");
              done();
              return undefined as any;
            }
            modelKey = `${model.provider}/${model.id}`;
          }

          const doSpawn = async () => {
            if (currentWorktreePath) {
              await discoverNewAgents(`${currentWorktreePath}/.pi/agents`);
            }

            const widget = getWidget();
            if (widget) {
              widget.setUICtx(ctx.ui as unknown as import("../agent-widget.ts").UICtx);
              widget.ensureTimer();
            }

            const coordinator = getCoordinator()!;
            try {
              const result = await coordinator.spawn(getPiInstance(), session!, {
                type: selectedType,
                prompt: spawnPrompt,
                description,
                model,
                modelKey,
                maxTurns,
                maxTokens,
                thinkingLevel: thinking,
                graceTurns,
                worktreePath: currentWorktreePath,
                worktreeLabel: currentWorktreePath ? currentWorktreeLabel : undefined,
                invocation: {
                  modelName: model?.id,
                  thinkingLevel: thinking,
                  maxTurns,
                  runInBackground: background,
                },
                runInBackground: background,
              });

              if (result.isBackground && !background) {
                ctx.ui.notify("MessageAgent is active, so this agent was started in the background.", "info");
              }
              getWidget()?.update();
            } catch (err) {
              ctx.ui.notify(`Spawn failed: ${err instanceof Error ? err.message : String(err)}`, "error");
            }
          };

          done();
          doneRef();
          doSpawn().catch(() => {});
          return undefined as any;
        },
      },
      {
        id: SEPARATOR_ID,
        label: " ",
        currentValue: "",
      },
      {
        id: "model",
        label: "Model",
        currentValue: displayModel,
        description: "Override the default model for this agent",
        submenu: createModelSelectSubmenu({
          modelOptions,
          showClear: false,
          projectOffered: store.projectTargetOffered,
          theme,
          onSet: (_target, model) => {
            currentModelStr = model === "(inherits parent)" || model === null ? "" : model;
            // Every thinking state resolves its level through currentModel(), so
            // the rebuilt row and the spawn value already reflect the new model.
            rebuild?.(buildItems());
          },
        }),
      },
      {
        id: "background",
        label: "Background",
        currentValue: currentBackground ? "ON" : "OFF",
        description: "Run in background; children with MessageAgent active are always backgrounded.",
        values: ["ON", "OFF"],
      },
      ...(inGitRepo
        ? [
            {
              id: "worktree",
              label: "Worktree",
              currentValue: currentWorktreeLabel,
              description: "Run in a linked git worktree instead of parent cwd",
              submenu: (_v: string, done: (v?: string) => void) => {
                const pickerItems = [
                  { value: "Inherits parent cwd", label: "Inherits parent cwd" },
                  ...worktrees.map((wt) => {
                    const branchLabel = wt.isDetached ? "detached" : (wt.branch ?? "detached");
                    const truncPath = truncatePath(wt.path);
                    return { value: wt.path, label: truncPath, provider: branchLabel };
                  }),
                ];
                return createSearchableSelect(
                  pickerItems,
                  {
                    onSelect: (value) => {
                      const wt = value === "Inherits parent cwd" ? undefined : worktrees.find((w) => w.path === value);
                      currentWorktreePath = wt?.path;
                      // Derived tracks the spawn target: re-read pi's settings
                      // there so the prediction shown on `pi default` follows
                      // the project the runner will resolve in.
                      refreshThinkingSnapshot(currentWorktreePath ?? parentThinkingCwd);
                      done(wt ? (wt.branch ?? "detached") : "Inherits parent cwd");
                    },
                    onCancel: () => done(),
                  },
                  theme,
                );
              },
            } as SettingItem,
          ]
        : []),
      {
        id: "thinkingLevel",
        label: "Thinking level",
        currentValue: thinkingDisplay(),
        description: "Set the reasoning effort level",
        submenu: createThinkingLevelSubmenu(currentModel, theme, setThinkingChoice),
      },
      {
        id: "maxTokens",
        label: "Max tokens",
        currentValue: fmtNum(currentMaxTokens),
        description: "Maximum tokens the agent can consume",
        submenu: createNumericSubmenu(
          ctx,
          (parsed) => {
            currentMaxTokens = parsed;
          },
          () => {
            currentMaxTokens = undefined;
          },
        ),
      },
      {
        id: "maxTurns",
        label: "Max turns",
        currentValue: fmtNum(currentMaxTurns),
        description: "Maximum conversation turns before hard stop",
        submenu: createNumericSubmenu(
          ctx,
          (parsed) => {
            currentMaxTurns = parsed;
          },
          () => {
            currentMaxTurns = undefined;
          },
        ),
      },
      {
        id: "graceTurns",
        label: "Grace turns",
        currentValue: String(currentGraceTurns),
        description: "Extra turns after soft limit before abort",
        submenu: createNumericSubmenu(ctx, { min: 0, default: DEFAULT_GRACE_TURNS }, (parsed) => {
          currentGraceTurns = parsed;
        }),
      },
      { id: SEPARATOR_ID, label: " ", currentValue: "" },
      {
        id: "description",
        label: "Description",
        currentValue: currentDescription,
        description: "Short label shown in the agents list",
        submenu: createInputSubmenu(ctx),
      },
      {
        id: "prompt",
        label: "Prompt",
        currentValue: prompt,
        description: "The user message sent to the agent",
        submenu: createInputSubmenu(ctx, { required: true }),
      },
    ];

    return items;
  };

  let theme: Theme;
  let doneRef: () => void;
  let rebuild: ((items: SettingItem[]) => void) | undefined;

  await ctx.ui.custom((_tui, t, _kb, done) => {
    theme = t;
    doneRef = () => done(undefined);

    const items = buildItems();
    const onChange = (id: string, newValue: string) => {
      switch (id) {
        case "thinkingLevel":
          setThinkingChoice(newValue);
          break;
        case "background":
          currentBackground = newValue === "ON";
          break;
        case "prompt":
          prompt = newValue;
          break;
      }
      // Rebuild items so displayed values stay in sync after any change
      rebuild?.(buildItems());
    };
    const settingsList = new SettingsList(items, 15, buildSettingsListTheme(theme), onChange, doneRef);
    return new SettingsListWrapper(settingsList, {
      title: "Spawn Options",
      theme,
      onCancel: () => doneRef(),
      onRebuild: (r) => {
        rebuild = r;
      },
    });
  });
}
