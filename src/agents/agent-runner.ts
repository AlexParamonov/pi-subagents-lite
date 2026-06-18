/**
 * Core execution engine: creates sessions, runs agents, collects results.
 *
 * Tool visibility policy is owned by agent-types.ts (resolveVisibleTools).
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  loadProjectContextFiles,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getAgentConfig, getConfig, getToolNamesForType, resolveVisibleTools } from "./agent-types.js";
import { extractText } from "../prompt/context.js";
import type { LifetimeUsage } from "./usage.js";
import { findModelInRegistry } from "../utils.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { buildAgentPrompt, type PromptExtras } from "../prompt/prompts.js";
import { preloadSkills, loadSkillMeta, type SkillMeta } from "../prompt/skill-loader.js";
import { type EnvInfo, type RunCallbacks, type RunTunables, SHORT_ID_LENGTH } from "../types.js";
import type { SubagentType, SystemPromptMode } from "./types.js";
import { getStore } from "../shell.js";
import { DEFAULT_GRACE_TURNS } from "../config/config-io.js";

/** Path to custom prompt file. Exported for use in menus.ts. */
export const CUSTOM_PROMPT_PATH = path.join(process.env.HOME || "", ".pi", "agent", "subagents-lite-prompt.md");


/** Timeout for quick git commands (branch detection, repo check). */
const GIT_EXEC_TIMEOUT_MS = 5000;

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}

/** Info about a tool event in the subagent. */
interface RunOptions extends RunTunables, RunCallbacks {
  /** ExtensionAPI instance — used for pi.exec() for git detection. */
  pi: ExtensionAPI;
  /** Manager-assigned id; suffixes session name to disambiguate parallel spawns (e.g. `Explore#a1b2c3d4`). */
  agentId?: string;
  /** Override working directory (resolved worktree path). */
  cwd?: string;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
}

interface RunResult {
  responseText: string;
  session: AgentSession;
  /** True if the agent was hard-aborted (max_turns + grace exceeded). */
  aborted: boolean;
  /** True if the agent hit the soft turn limit and wrapped up within grace turns. */
  turnLimited: boolean;
}

/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
function collectResponseText(
  session: AgentSession,
  onTextDelta?: (delta: string, fullText: string) => void,
) {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") {
      text = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
      onTextDelta?.(event.assistantMessageEvent.delta, text);
    }
  });
  return { getText: () => text, unsubscribe };
}

/** Get the last assistant text from the completed session history. */
function getLastAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const onAbort = () => session.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * Extract a LifetimeUsage from a runtime assistant message_end event.
 * pi-ai attaches `usage: { input, output, cacheWrite, cost: { total } }` to
 * assistant messages at runtime, but this shape isn't reflected in the
 * AgentSessionEvent public types.
 */
function usageFromAssistantMessage(msg: Record<string, unknown>): LifetimeUsage | undefined {
  const usage = msg.usage as Record<string, unknown> | undefined;
  if (!usage) return undefined;
  return {
    input: (usage.input as number) ?? 0,
    output: (usage.output as number) ?? 0,
    cacheWrite: (usage.cacheWrite as number) ?? 0,
    cost: ((usage.cost as Record<string, unknown>)?.total as number) ?? 0,
  };
}

/**
 * Subscribe to shared session events (tool activity, usage, compaction)
 * used by runAgent. Returns an unsubscribe function.
 */
export function subscribeToSessionEvents(
  session: AgentSession,
  options: Pick<RunOptions, "onToolActivity" | "onAssistantUsage" | "onCompaction">,
): () => void {
  if (!options.onToolActivity && !options.onAssistantUsage && !options.onCompaction) {
    return () => {};
  }
  return session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "tool_execution_start") {
      options.onToolActivity?.({ type: "start", toolName: event.toolName });
    }
    if (event.type === "tool_execution_end") {
      options.onToolActivity?.({ type: "end", toolName: event.toolName });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const msg = event.message as unknown as Record<string, unknown>;
      const usage = usageFromAssistantMessage(msg);
      if (usage) {
        options.onAssistantUsage?.(usage);
      }
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
    }
  });
}

/**
 * Extract the extension name from an extension's file path.
 *
 * Handles all distribution methods:
 *  - git packages: `.../git/github.com/<user>/<pkg>/...` → "<pkg>"
 *  - npm packages: `.../node_modules/[...]pkg/...` → "pkg"
 *  - local extensions: `~/.pi/agent/extensions/<name>/...` → "<name>"
 *  - direct files: `extensions/<name>.ts` → "<name>"
 *
 * Does NOT depend on internal directory structure (dist/, lib/, src/, etc).
 * Only cares about the package root, which is determined by distribution method.
 */
function extractExtensionName(extPath: string): string {
  const parts = extPath.split(path.sep);

  // 1. Git package: .../git/github.com/<user>/<pkg>/...
  //    Package name is 3 dirs after 'git' (github.com/user/pkg)
  const gitIdx = parts.indexOf("git");
  if (gitIdx !== -1 && gitIdx + 3 < parts.length) {
    return parts[gitIdx + 3];
  }

  // 2. npm package: .../node_modules/[...]pkg/...
  const nmIdx = parts.lastIndexOf("node_modules");
  if (nmIdx !== -1 && nmIdx + 1 < parts.length) {
    const next = parts[nmIdx + 1];
    if (next.startsWith("@") && nmIdx + 2 < parts.length) {
      return parts[nmIdx + 2]; // @scope/pkg → pkg
    }
    return next;
  }

  // 3. Local extension: .../extensions/<name>/... or .../extensions/<name>.ts
  const extIdx = parts.lastIndexOf("extensions");
  if (extIdx !== -1 && extIdx + 1 < parts.length) {
    const afterExt = parts[extIdx + 1];
    // Subdirectory: extensions/tavily/index.ts → tavily
    if (afterExt && !afterExt.includes(".")) {
      return afterExt;
    }
    // Direct file: extensions/review.ts → review
    const file = parts[parts.length - 1];
    return path.basename(file, path.extname(file));
  }

  // Fallback: parent dir name
  return path.basename(path.dirname(extPath));
}

/** Run a git command via pi.exec, returning stdout on success or null on failure. */
async function execGit(pi: ExtensionAPI, args: string[], cwd: string): Promise<string | null> {
  try {
    const result = await pi.exec("git", args, { cwd, timeout: GIT_EXEC_TIMEOUT_MS });
    return result.code === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Detect environment info using pi.exec() for git detection.
 * Inline replacement for upstream's detectEnv from env.ts.
 */
async function detectEnv(pi: ExtensionAPI, cwd: string): Promise<EnvInfo> {
  const gitRoot = await execGit(pi, ["rev-parse", "--is-inside-work-tree"], cwd);
  const isGitRepo = gitRoot === "true";
  const branch = isGitRepo ? (await execGit(pi, ["branch", "--show-current"], cwd)) : null;

  return {
    isGitRepo,
    branch,
    platform: process.platform,
  };
}

// ── runAgent phases ────────────────────────────────────────────────

/**
 * Resolve system prompt mode, fetch the appropriate source prompt, and
 * load project context files. Returns everything buildPrompt needs.
 */
function resolveSystemPromptSources(
  ctx: ExtensionContext,
  cwd: string,
  notify: (msg: string) => void,
): { mode: SystemPromptMode; extras: Pick<PromptExtras, "parentSystemPrompt" | "customSystemPrompt" | "contextFiles"> } {
  const store = getStore();
  const mode = store.agent.systemPromptMode;
  const extras: Pick<PromptExtras, "parentSystemPrompt" | "customSystemPrompt" | "contextFiles"> = {};

  // Fetch parent system prompt for inherit mode
  if (mode === "inherit") {
    try {
      extras.parentSystemPrompt = ctx.getSystemPrompt();
    } catch (err) {
      notify(`Failed to get parent system prompt: ${err}. Falling back to replace mode.`);
    }
  }

  // Read custom prompt file for custom mode
  if (mode === "custom") {
    try {
      const content = fs.readFileSync(CUSTOM_PROMPT_PATH, "utf-8").trim();
      if (content) {
        extras.customSystemPrompt = content;
      } else {
        notify(`Custom prompt file is empty: ${CUSTOM_PROMPT_PATH}. Falling back to replace mode.`);
      }
    } catch (err: any) {
      if (err.code === "ENOENT") {
        notify(`Custom prompt file not found: ${CUSTOM_PROMPT_PATH}. Falling back to replace mode.`);
      } else {
        notify(`Failed to read custom prompt file: ${err.message}. Falling back to replace mode.`);
      }
    }
  }

  // Load AGENTS.md context files when the setting is enabled
  if (store.agent.includeContextFiles) {
    try {
      extras.contextFiles = loadProjectContextFiles({ cwd, agentDir: getAgentDir() });
    } catch {
      // Non-fatal: context files are supplementary
    }
  }

  return { mode, extras };
}

/**
 * Phase 1: Resolve system prompt from agent config, skills, and env info.
 *
 * @param resolverExtras  Partial extras from resolveSystemPromptSources (mode-specific prompts + context files).
 */
function buildPrompt(
  type: SubagentType,
  agentConfig: ReturnType<typeof getAgentConfig>,
  config: ReturnType<typeof getConfig>,
  cwd: string,
  env: EnvInfo,
  systemPromptMode: SystemPromptMode = "replace",
  resolverExtras: Pick<PromptExtras, "parentSystemPrompt" | "customSystemPrompt" | "contextFiles"> = {},
): string {
  const extras: PromptExtras = { ...resolverExtras };
  if (Array.isArray(agentConfig?.preloadSkills)) {
    extras.skillBlocks = preloadSkills(agentConfig.preloadSkills, cwd);
  }
  if (Array.isArray(config.skills)) {
    extras.skillMetas = loadSkillMeta(config.skills, cwd);
  }
  if (agentConfig) {
    return buildAgentPrompt(agentConfig, cwd, env, extras, systemPromptMode);
  }
  const fallback = DEFAULT_AGENTS.get("general-purpose");
  if (!fallback) throw new Error(`No fallback config available for unknown type "${type}"`);
  return buildAgentPrompt({ ...fallback, name: type }, cwd, env, extras, systemPromptMode);
}

/** Build extension name → tool names map from loaded extensions. */
function buildExtToolMap(extensions: Array<{ path: string; tools: Map<string, unknown> }>) {
  const map = new Map<string, string[]>();
  for (const ext of extensions) {
    const name = extractExtensionName(ext.path);
    const tools = [...ext.tools.keys()];
    if (tools.length > 0) map.set(name, tools);
  }
  return map;
}

/** Build extension override for whitelist or blacklist filtering. */
function buildExtOverride(
  extensions: true | string[] | false | undefined,
  excludeExtensions?: string[],
) {
  if (Array.isArray(extensions)) {
    const allowedNames = new Set(extensions.map(ext => {
      const slashIdx = ext.indexOf("/");
      return slashIdx !== -1 ? ext.slice(0, slashIdx) : ext;
    }));
    return (result: any) => ({
      ...result,
      extensions: result.extensions.filter((ext: { path: string }) =>
        allowedNames.has(extractExtensionName(ext.path)),
      ),
    });
  }
  if (excludeExtensions) {
    const excludeSet = new Set(excludeExtensions);
    return (result: any) => ({
      ...result,
      extensions: result.extensions.filter((ext: { path: string }) =>
        !excludeSet.has(extractExtensionName(ext.path)),
      ),
    });
  }
  return undefined;
}

/**
 * Phase 2: Build DefaultResourceLoader with extension filtering.
 * Returns the loader and a function that reloads it and builds the ext→tool map.
 */
function createResourceLoader(
  config: ReturnType<typeof getConfig>,
  agentConfig: ReturnType<typeof getAgentConfig>,
  cwd: string,
  systemPrompt: string,
) {
  const extensions = config.extensions;
  const noSkills = config.skills === false
    || Array.isArray(config.skills)
    || Array.isArray(agentConfig?.preloadSkills);
  const agentDir = getAgentDir();
  const loaderOpts: ConstructorParameters<typeof DefaultResourceLoader>[0] = {
    cwd, agentDir,
    noExtensions: extensions === false, noSkills,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    extensionsOverride: buildExtOverride(extensions, agentConfig?.excludeExtensions),
  };
  const loader = new DefaultResourceLoader(loaderOpts);
  return {
    loader,
    reloadAndMap: async () => {
      await loader.reload();
      const extResult = loader.getExtensions();
      return { extResult, extToolMap: buildExtToolMap(extResult.extensions) };
    },
  };
}

/** Create an agent session with the resolved model and thinking level. */
async function initSession(
  ctx: ExtensionContext,
  options: RunOptions,
  agentConfig: ReturnType<typeof getAgentConfig>,
  type: SubagentType,
  cwd: string,
  loader: DefaultResourceLoader,
) {
  const model = options.model ?? findModelInRegistry(
    agentConfig?.model, ctx.modelRegistry, ctx.model,
  );
  const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinkingLevel;
  const agentDir = getAgentDir();
  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    cwd, agentDir,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.create(cwd, agentDir),
    modelRegistry: ctx.modelRegistry, model,
    tools: getToolNamesForType(type), resourceLoader: loader,
  };
  if (thinkingLevel) sessionOpts.thinkingLevel = thinkingLevel;
  const result = await createAgentSession(sessionOpts);

  // Inject max_tokens into provider request payloads.
  // Spawn-time value wins over agent config (frontmatter).
  const maxTokens = options.maxTokens ?? agentConfig?.maxTokens;
  if (maxTokens != null && maxTokens > 0 && model) {
    const field = (model.compat as any)?.maxTokensField ?? "max_tokens";
    const origOnPayload = result.session.agent.onPayload;
    result.session.agent.onPayload = async (payload, m) => {
      const applied = origOnPayload ? (await origOnPayload(payload, m)) ?? payload : payload;
      const obj = typeof applied === "object" && applied && !Array.isArray(applied) ? applied : {};
      return { ...obj, [field]: maxTokens };
    };
  }

  return result;
}

/**
 * Phase 3: Create session, bind extensions, filter tools.
 */
async function createAndConfigureSession(
  ctx: ExtensionContext,
  options: RunOptions,
  agentConfig: ReturnType<typeof getAgentConfig>,
  type: SubagentType,
  cwd: string,
  loader: DefaultResourceLoader,
  extResult: { extensions: Array<{ path: string; tools: Map<string, unknown> }> },
  notify: (msg: string) => void,
): Promise<AgentSession> {
  const { session } = await initSession(ctx, options, agentConfig, type, cwd, loader);
  const baseName = agentConfig?.name ?? type;
  session.setSessionName(
    options.agentId ? `${baseName}#${options.agentId.slice(0, SHORT_ID_LENGTH)}` : baseName,
  );
  await session.bindExtensions({
    onError: (err) => options.onToolActivity?.({
      type: "end", toolName: `extension-error:${err.extensionPath}`,
    }),
  });
  const filteredTools = resolveVisibleTools({
    activeTools: session.getActiveToolNames(),
    tools: agentConfig?.tools,
    excludeTools: agentConfig?.excludeTools,
    extToolMap: buildExtToolMap(extResult.extensions),
    notify,
  });
  if (filteredTools) session.setActiveToolsByName(filteredTools);
  options.onSessionCreated?.(session);
  return session;
}

/**
 * Phase 4: Subscribe to turn_end events for graceful max_turns enforcement.
 * Returns an unsubscribe function and state getters.
 */
function wireTurnTracking(
  session: AgentSession,
  options: Pick<RunOptions, "maxTurns" | "graceTurns" | "onTurnEnd">,
) {
  let turnCount = 0;
  const maxTurns = normalizeMaxTurns(options.maxTurns);
  let softLimitReached = false;
  let aborted = false;
  const graceTurns = options.graceTurns ?? DEFAULT_GRACE_TURNS;

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type !== "turn_end") return;
    turnCount++;
    options.onTurnEnd?.(turnCount);
    if (maxTurns == null) return;
    if (!softLimitReached && turnCount >= maxTurns) {
      softLimitReached = true;
      session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
    } else if (softLimitReached && turnCount >= maxTurns + graceTurns) {
      aborted = true;
      session.abort();
    }
  });

  return { unsubscribe, getAborted: () => aborted, getSteered: () => softLimitReached };
}

/**
 * Phase 5: Execute the prompt turn loop with event wiring and cleanup.
 */
async function runTurnLoop(
  session: AgentSession,
  prompt: string,
  options: RunOptions,
  unsubTurns: () => void,
) {
  const unsubEvents = subscribeToSessionEvents(session, options);
  const collector = collectResponseText(session, options.onTextDelta);
  const cleanupAbort = forwardAbortSignal(session, options.signal);
  try {
    await session.prompt(prompt);
  } finally {
    unsubTurns();
    unsubEvents();
    collector.unsubscribe();
    cleanupAbort();
  }
  return collector.getText().trim() || getLastAssistantText(session);
}

// ── main entry ─────────────────────────────────────────────────────

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  const store = getStore();
  const config = getConfig(type, store.agent.loadSkillsImplicitly, store.agent.loadExtensionsImplicitly);
  const agentConfig = getAgentConfig(type);

  // Warn on mutual exclusion violations
  const notify = (msg: string) => {
    if (ctx.ui?.notify) ctx.ui.notify(`[pi-subagents] ${msg}`, "warning");
    else console.warn(`[pi-subagents] ${msg}`);
  };
  if (agentConfig?.excludeTools && Array.isArray(agentConfig.tools)) {
    notify(`agent "${type}": both tools and exclude_tools set — tools (whitelist) wins`);
  }
  if (agentConfig?.excludeExtensions && Array.isArray(agentConfig.extensions)) {
    notify(`agent "${type}": both extensions and exclude_extensions set — extensions (whitelist) wins`);
  }

  const effectiveCwd = options.cwd ?? ctx.cwd;
  const env = await detectEnv(options.pi, effectiveCwd);

  // Resolve system prompt mode + source prompts + context files
  const { mode, extras: promptExtras } = resolveSystemPromptSources(ctx, effectiveCwd, notify);

  const systemPrompt = buildPrompt(
    type, agentConfig, config, effectiveCwd, env,
    mode, promptExtras,
  );
  const { loader, reloadAndMap } = createResourceLoader(config, agentConfig, effectiveCwd, systemPrompt);
  const { extResult } = await reloadAndMap();
  const session = await createAndConfigureSession(
    ctx, options, agentConfig, type, effectiveCwd, loader, extResult, notify,
  );
  const { unsubscribe: unsubTurns, getAborted, getSteered } = wireTurnTracking(session, {
    ...options,
    maxTurns: options.maxTurns ?? agentConfig?.maxTurns,
  });

  const responseText = await runTurnLoop(session, prompt, options, unsubTurns);
  return { responseText, session, aborted: getAborted(), turnLimited: getSteered() };
}
