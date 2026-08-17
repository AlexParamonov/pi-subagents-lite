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
import {
  getAgentConfig,
  getConfig,
  getToolNamesForType,
  resolveSessionAllowedTools,
  resolveVisibleTools,
} from "./agent-types.js";
import { extractText } from "../prompt/context.js";
import { readDefaultTools } from "../pi-settings.js";
import type { AgentUsage } from "./usage.js";
import { findModelInRegistry, GIT_EXEC_TIMEOUT_MS } from "../utils.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { buildAgentPrompt, type PromptExtras } from "../prompt/prompts.js";
import { preloadSkills, loadSkillMeta } from "../prompt/skill-loader.js";
import { type EnvInfo, type RunCallbacks, type RunTunables, SHORT_ID_LENGTH } from "../types.js";
import type { SubagentType, SystemPromptMode } from "./types.js";
import { getStore, enterSubagentSpawn, exitSubagentSpawn } from "../shell.js";
import { DEFAULT_GRACE_TURNS, CUSTOM_PROMPT_PATH } from "../config/config-io.js";
import { patchRetryClassifier } from "./stream-retry.js";

// Cache: extension path → unscoped package name (lowercased), or undefined if not found
const packageNameCache = new Map<string, string | undefined>();

function extensionPackageName(extPath: string): string | undefined {
  // Presence check distinguishes a cached undefined (not-found) from a miss,
  // so each path's package.json is read at most once per process.
  if (packageNameCache.has(extPath)) return packageNameCache.get(extPath);
  const result = resolvePackageShortName(extPath);
  packageNameCache.set(extPath, result);
  return result;
}

/**
 * The unscoped, lowercased npm short name of the pi package that declares
 * `extPath` as an extension entry — or undefined if the entry doesn't belong
 * to such a package.
 *
 * Climbs from the entry's directory looking for package.json, stopping at
 * node_modules boundaries. The name is taken only when that package's
 * `pi.extensions` manifest actually lists this entry. Returns at the first
 * package.json (whether or not it declares the entry) so a loose extension
 * is never misattributed to a co-located project's name.
 */
function resolvePackageShortName(extPath: string): string | undefined {
  const entry = path.resolve(extPath);
  let dir = path.dirname(entry);

  for (;;) {
    // Climbing into node_modules means we've left the owning package's tree.
    if (path.basename(dir) === "node_modules") return undefined;

    let pkg: { name?: unknown; pi?: { extensions?: unknown } };
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return undefined; // walked to the filesystem root
      dir = parent;
      continue;
    }

    // First package.json found — it's the package root; decide here.
    const entries = pkg.pi?.extensions;
    if (
      typeof pkg.name === "string" &&
      Array.isArray(entries) &&
      entries.some((e) => typeof e === "string" && path.resolve(dir, e) === entry)
    ) {
      const short = pkg.name.startsWith("@") ? pkg.name.slice(pkg.name.indexOf("/") + 1) : pkg.name;
      return short.toLowerCase();
    }
    return undefined;
  }
}

/** Clear the package name cache. Exposed for test isolation. */
export function resetPackageNameCache() {
  packageNameCache.clear();
}

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}

interface RunOptions extends RunTunables, RunCallbacks {
  /** ExtensionAPI instance — used for pi.exec() for git detection. */
  pi: ExtensionAPI;
  /** Manager-assigned id; suffixes session name to disambiguate parallel spawns (e.g. `Explore#a1b2c3d4`). */
  agentId?: string;
  cwd?: string;
  /**
   * Trust state for the target project. False = ignore the target's project
   * resources (untrusted cross-repo target). Absent/true = load them.
   */
  projectTrusted?: boolean;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
}

export interface RunResult {
  responseText: string;
  session: AgentSession;
  /** True if the agent was hard-aborted (max_turns + grace exceeded). */
  aborted: boolean;
  /** True if the agent hit the soft turn limit and wrapped up within grace turns. */
  turnLimited: boolean;
  /**
   * Provider error message when the run ended in a model error: the final
   * assistant message has stopReason "error". Absent for normal, aborted,
   * and turn-limited runs, and for transient errors superseded by a later turn.
   */
  modelError?: string;
}

/**
 * Options for prompting a session, whether first run or continuation.
 * Carries the callbacks the manager wires for record tracking and live-view
 * updates; the session itself is reused by continuations.
 */
export interface SessionPromptOptions extends RunCallbacks {
  maxTurns?: number;
  graceTurns?: number;
  /** Abort signal forwarded to session.abort() while the prompt runs. */
  signal?: AbortSignal;
}

function collectResponseText(session: AgentSession, onTextDelta?: (delta: string, fullText: string) => void) {
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

function getLastAssistantText(session: AgentSession, fromIndex: number): string {
  for (let i = session.messages.length - 1; i >= fromIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

/**
 * The provider error message when the run ended in a model error: the final
 * assistant message has stopReason "error". Returns undefined when the final
 * assistant message ended normally (or was aborted), so a transient error
 * followed by a successful turn never fails the run.
 */
function getFinalModelError(session: AgentSession): string | undefined {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    if (msg.stopReason !== "error") return undefined;
    return msg.errorMessage && msg.errorMessage.trim() ? msg.errorMessage : undefined;
  }
  return undefined;
}

function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  // abort() returns a promise and this fires from an event listener, so a
  // rejection escapes the run rather than failing it. Node re-throws a
  // listener's returned rejected promise as an uncaught exception, and the
  // parent is already going down when this runs.
  const onAbort = () => {
    void session.abort().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * Extract a LifetimeUsage from a runtime assistant message_end event.
 * pi-ai attaches `usage: { input, output, cacheWrite, cost: { total } }` to
 * assistant messages at runtime, but this shape isn't reflected in the
 * AgentSessionEvent public types.
 */
function usageFromAssistantMessage(msg: Record<string, unknown>): AgentUsage | undefined {
  const usage = msg.usage as Record<string, unknown> | undefined;
  if (!usage) return undefined;
  return {
    input: (usage.input as number) ?? 0,
    output: (usage.output as number) ?? 0,
    cacheWrite: (usage.cacheWrite as number) ?? 0,
    cacheRead: (usage.cacheRead as number) ?? 0,
    cost: ((usage.cost as Record<string, unknown>)?.total as number) ?? 0,
  };
}

export function subscribeToSessionEvents(
  session: AgentSession,
  options: Pick<RunCallbacks, "onToolActivity" | "onAssistantUsage" | "onCompaction">,
): () => void {
  if (!options.onToolActivity && !options.onAssistantUsage && !options.onCompaction) {
    return () => {};
  }
  return session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "tool_execution_start") {
      options.onToolActivity?.({ type: "start", toolName: event.toolName, toolCallId: event.toolCallId });
    }
    if (event.type === "tool_execution_end") {
      options.onToolActivity?.({ type: "end", toolName: event.toolName, toolCallId: event.toolCallId });
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

/** Extension name from its install path (git/npm/local/direct); independent of dist/lib/src internals. */
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

async function execGit(pi: ExtensionAPI, args: string[], cwd: string): Promise<string | null> {
  try {
    const result = await pi.exec("git", args, { cwd, timeout: GIT_EXEC_TIMEOUT_MS });
    return result.code === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** Inline replacement for upstream's detectEnv — uses pi.exec for git detection. */
async function detectEnv(pi: ExtensionAPI, cwd: string): Promise<EnvInfo> {
  const gitRoot = await execGit(pi, ["rev-parse", "--is-inside-work-tree"], cwd);
  const isGitRepo = gitRoot === "true";
  const branch = isGitRepo ? await execGit(pi, ["branch", "--show-current"], cwd) : null;

  return {
    isGitRepo,
    branch,
    platform: process.platform,
  };
}

// ── runAgent phases ────────────────────────────────────────────────

/**
 * Effective system prompt mode for an agent: the global mode overridden by
 * the agent's include_system_prompt frontmatter field.
 *
 * - false → replace (never inherit or custom)
 * - true → inherit, except when the global mode is custom (custom wins)
 * - undefined → global mode
 */
export function resolveEffectiveSystemPromptMode(
  globalMode: SystemPromptMode,
  includeSystemPrompt: boolean | undefined,
): SystemPromptMode {
  if (includeSystemPrompt === false) return "replace";
  if (includeSystemPrompt === true && globalMode !== "custom") return "inherit";
  return globalMode;
}

function resolveSystemPromptSources(
  ctx: ExtensionContext,
  cwd: string,
  notify: (msg: string) => void,
  agentConfig: ReturnType<typeof getAgentConfig>,
): {
  mode: SystemPromptMode;
  extras: Pick<PromptExtras, "parentSystemPrompt" | "customSystemPrompt" | "contextFiles">;
} {
  const store = getStore();
  // Per-agent frontmatter overrides win; unset fields follow the global config.
  const mode = resolveEffectiveSystemPromptMode(store.agent.systemPromptMode, agentConfig?.includeSystemPrompt);
  const includeContextFiles = agentConfig?.includeContextFiles ?? store.agent.includeContextFiles;
  const extras: Pick<PromptExtras, "parentSystemPrompt" | "customSystemPrompt" | "contextFiles"> = {};

  if (mode === "inherit") {
    try {
      extras.parentSystemPrompt = ctx.getSystemPrompt();
    } catch (err) {
      notify(`Failed to get parent system prompt: ${err}. Falling back to replace mode.`);
    }
  }

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

  if (includeContextFiles) {
    try {
      extras.contextFiles = loadProjectContextFiles({ cwd, agentDir: getAgentDir() });
    } catch {
      // Non-fatal: context files are supplementary
    }
  }

  return { mode, extras };
}

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

function buildExtToolMap(extensions: Array<{ path: string; tools: Map<string, unknown> }>) {
  const map = new Map<string, string[]>();
  for (const ext of extensions) {
    const name = extractExtensionName(ext.path);
    const tools = [...ext.tools.keys()];
    if (tools.length > 0) map.set(name, tools);
  }
  return map;
}

/** Filter extensions by name; invert=true removes matches (blacklist), false keeps them (whitelist). */
function filterExtensions(
  extensions: Array<{ path: string }>,
  names: Set<string>,
  invert: boolean,
): { filtered: Array<{ path: string }>; matched: Set<string> } {
  const matched = new Set<string>();
  const filtered = extensions.filter((ext) => {
    const pathName = extractExtensionName(ext.path).toLowerCase();
    const pkgName = extensionPackageName(ext.path);
    const hit = names.has(pathName) || (pkgName !== undefined && names.has(pkgName));
    if (hit) {
      matched.add(pathName);
      if (pkgName) matched.add(pkgName);
    }
    return hit !== invert;
  });
  return { filtered, matched };
}

/** Extension filter override; warns for requested names that matched nothing. */
function filterOverride(names: Set<string>, invert: boolean, notify?: (msg: string) => void) {
  return (result: any) => {
    const { filtered, matched } = filterExtensions(result.extensions, names, invert);
    for (const name of names) {
      if (!matched.has(name)) {
        notify?.(`extension "${name}" not found in loaded extensions`);
      }
    }
    return { ...result, extensions: filtered };
  };
}

export function buildExtOverride(
  extensions: true | string[] | false | undefined,
  excludeExtensions?: string[],
  notify?: (msg: string) => void,
) {
  if (Array.isArray(extensions)) {
    // Whitelist entries may carry a /tool suffix; match on the extension name only.
    const allowedNames = new Set(
      extensions.map((ext) => {
        const slashIdx = ext.indexOf("/");
        return (slashIdx !== -1 ? ext.slice(0, slashIdx) : ext).toLowerCase();
      }),
    );
    return filterOverride(allowedNames, false, notify);
  }

  if (excludeExtensions) {
    const excludeSet = new Set(excludeExtensions.map((n) => n.toLowerCase()));
    return filterOverride(excludeSet, true, notify);
  }

  return undefined;
}

function createResourceLoader(
  config: ReturnType<typeof getConfig>,
  agentConfig: ReturnType<typeof getAgentConfig>,
  cwd: string,
  systemPrompt: string,
  settingsManager: SettingsManager,
  notify?: (msg: string) => void,
) {
  const extensions = config.extensions;
  const noSkills = config.skills === false || Array.isArray(config.skills) || Array.isArray(agentConfig?.preloadSkills);
  const agentDir = getAgentDir();
  const loaderOpts: ConstructorParameters<typeof DefaultResourceLoader>[0] = {
    cwd,
    agentDir,
    settingsManager,
    noExtensions: extensions === false,
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    extensionsOverride: buildExtOverride(extensions, agentConfig?.excludeExtensions, notify),
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

async function initSession(
  ctx: ExtensionContext,
  options: RunOptions,
  agentConfig: ReturnType<typeof getAgentConfig>,
  type: SubagentType,
  cwd: string,
  loader: DefaultResourceLoader,
  extToolMap: Map<string, string[]>,
  settingsManager: SettingsManager,
  defaultTools: string[] | undefined,
): Promise<AgentSession> {
  const model = options.model ?? findModelInRegistry(agentConfig?.model, ctx.modelRegistry, ctx.model);
  const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinkingLevel;
  const agentDir = getAgentDir();
  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    model,
    tools: resolveSessionAllowedTools({
      registeredTools: getToolNamesForType(type, defaultTools),
      tools: agentConfig?.tools,
      extToolMap,
    }),
    resourceLoader: loader,
  };
  if (thinkingLevel) sessionOpts.thinkingLevel = thinkingLevel;
  const result = await createAgentSession(sessionOpts);
  const session = result.session;
  patchRetryClassifier(session);

  // Inject max_tokens into provider payloads; spawn-time value wins over agent config.
  const maxTokens = options.maxTokens ?? agentConfig?.maxTokens;
  if (maxTokens != null && maxTokens > 0 && model) {
    const field = (model.compat as any)?.maxTokensField ?? "max_tokens";
    const origOnPayload = session.agent.onPayload;
    session.agent.onPayload = async (payload, m) => {
      const applied = origOnPayload ? ((await origOnPayload(payload, m)) ?? payload) : payload;
      const obj = typeof applied === "object" && applied && !Array.isArray(applied) ? applied : {};
      return { ...obj, [field]: maxTokens };
    };
  }

  return session;
}

async function createAndConfigureSession(
  ctx: ExtensionContext,
  options: RunOptions,
  agentConfig: ReturnType<typeof getAgentConfig>,
  type: SubagentType,
  cwd: string,
  loader: DefaultResourceLoader,
  extToolMap: Map<string, string[]>,
  settingsManager: SettingsManager,
  defaultTools: string[] | undefined,
  notify: (msg: string) => void,
): Promise<AgentSession> {
  const session = await initSession(
    ctx,
    options,
    agentConfig,
    type,
    cwd,
    loader,
    extToolMap,
    settingsManager,
    defaultTools,
  );
  const baseName = agentConfig?.name ?? type;
  session.setSessionName(options.agentId ? `${baseName}#${options.agentId.slice(0, SHORT_ID_LENGTH)}` : baseName);
  await session.bindExtensions({
    onError: (err) =>
      options.onToolActivity?.({
        type: "end",
        toolName: `extension-error:${err.extensionPath}`,
      }),
  });

  const filteredTools = resolveVisibleTools({
    activeTools: session.getActiveToolNames(),
    tools: agentConfig?.tools,
    excludeTools: agentConfig?.excludeTools,
    extToolMap,
    notify,
  });
  if (filteredTools) session.setActiveToolsByName(filteredTools);
  options.onSessionCreated?.(session);
  return session;
}
function wireTurnTracking(session: AgentSession, options: Pick<RunOptions, "maxTurns" | "graceTurns" | "onTurnEnd">) {
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
      // steer() returns a promise and fires from a subscribe callback: a
      // rejection would escape the run. It only costs the graceful wrap-up;
      // the hard abort below still fires.
      void session
        .steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.")
        .catch(() => {});
    } else if (softLimitReached && turnCount >= maxTurns + graceTurns) {
      aborted = true;
      // `aborted` is already set, so a rejected abort() cannot change the
      // reported outcome — only swallow the rejection.
      void session.abort().catch(() => {});
    }
  });

  return { unsubscribe, getAborted: () => aborted, getTurnLimited: () => softLimitReached };
}

async function runTurnLoop(
  session: AgentSession,
  prompt: string,
  options: { signal?: AbortSignal } & RunCallbacks,
  unsubTurns: () => void,
) {
  const unsubEvents = subscribeToSessionEvents(session, options);
  const collector = collectResponseText(session, options.onTextDelta);
  const cleanupAbort = forwardAbortSignal(session, options.signal);
  // Messages already in the session before this prompt belong to earlier runs;
  // the fallback must not surface their text when this run fails (model error
  // or abort with no output) — that would resurrect a prior run's result.
  const messageStart = session.messages.length;
  try {
    await session.prompt(prompt);
  } finally {
    unsubTurns();
    unsubEvents();
    collector.unsubscribe();
    cleanupAbort();
  }
  return collector.getText().trim() || getLastAssistantText(session, messageStart);
}

/**
 * Run a single prompt against a session: wire turn tracking, event
 * subscription, response collection, and abort forwarding, prompt, then
 * assemble the RunResult. Shared by the first run (runAgentImpl) and
 * continuations (continueAgentSession) so the two paths cannot drift.
 */
async function runSessionPrompt(
  session: AgentSession,
  prompt: string,
  options: SessionPromptOptions,
): Promise<RunResult> {
  const { unsubscribe: unsubTurns, getAborted, getTurnLimited } = wireTurnTracking(session, options);
  const responseText = await runTurnLoop(session, prompt, options, unsubTurns);
  return {
    responseText,
    session,
    aborted: getAborted(),
    turnLimited: getTurnLimited(),
    modelError: getFinalModelError(session),
  };
}

/**
 * Prompt an existing session after its original run settled (the fork's
 * continueAgentSession() shape).
 *
 * Unlike runAgent, the session already exists: onSessionCreated is never
 * called, and there is no session setup (model resolution, resource loader,
 * tool filtering). The result keeps the runAgent shape (including
 * modelError) so the manager classifies the continuation exactly like the
 * first run.
 */
export async function continueAgentSession(
  session: AgentSession,
  prompt: string,
  options: SessionPromptOptions = {},
): Promise<RunResult> {
  return runSessionPrompt(session, prompt, options);
}

// ── main entry ─────────────────────────────────────────────────────

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  // Bracket the whole subagent lifecycle so the extension factory can detect
  // it's being re-loaded inside a subagent and avoid clobbering the parent shell.
  enterSubagentSpawn();
  try {
    return await runAgentImpl(ctx, type, prompt, options);
  } finally {
    exitSubagentSpawn();
  }
}

async function runAgentImpl(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  const store = getStore();
  const effectiveCwd = options.cwd ?? ctx.cwd;

  // One SettingsManager for the whole spawn: its trust state gates both the
  // resource loader (project extensions/skills/prompts/themes/system prompt
  // files) and the session context (ctx.isProjectTrusted). Created before
  // getConfig so its defaultTools setting can feed the resolved config and
  // the session tool gate from the same instance.
  const settingsManager = SettingsManager.create(effectiveCwd, getAgentDir(), {
    projectTrusted: options.projectTrusted !== false,
  });

  // Read once per spawn: getConfig and getToolNamesForType share this value,
  // so their fallbacks cannot diverge. undefined = setting unconfigured.
  const defaultTools = readDefaultTools(settingsManager);

  const config = getConfig(type, store.agent.loadSkillsImplicitly, store.agent.loadExtensionsImplicitly, defaultTools);
  const agentConfig = getAgentConfig(type);

  // Buffer warnings during setup to avoid inserting custom_message entries
  // between tool_use and tool_result in the session tree (causes Anthropic 400).
  // Flushed after runTurnLoop completes.
  const warnings: string[] = [];
  const bufferNotify = (msg: string) => {
    warnings.push(msg);
  };
  if (agentConfig?.excludeTools && Array.isArray(agentConfig.tools)) {
    bufferNotify(`agent "${type}": both tools and exclude_tools set — tools (whitelist) wins`);
  }
  if (agentConfig?.excludeExtensions && Array.isArray(agentConfig.extensions)) {
    bufferNotify(`agent "${type}": both extensions and exclude_extensions set — extensions (whitelist) wins`);
  }

  const env = await detectEnv(options.pi, effectiveCwd);

  const { mode, extras: promptExtras } = resolveSystemPromptSources(ctx, effectiveCwd, bufferNotify, agentConfig);

  const systemPrompt = buildPrompt(type, agentConfig, config, effectiveCwd, env, mode, promptExtras);
  const { loader, reloadAndMap } = createResourceLoader(
    config,
    agentConfig,
    effectiveCwd,
    systemPrompt,
    settingsManager,
    bufferNotify,
  );
  const { extToolMap } = await reloadAndMap();
  const session = await createAndConfigureSession(
    ctx,
    options,
    agentConfig,
    type,
    effectiveCwd,
    loader,
    extToolMap,
    settingsManager,
    defaultTools,
    bufferNotify,
  );
  const result = await runSessionPrompt(session, prompt, {
    ...options,
    maxTurns: options.maxTurns ?? agentConfig?.maxTurns,
  });

  // Flush buffered warnings now that tool_result is in the session tree.
  for (const msg of warnings) {
    if (ctx.ui?.notify) ctx.ui.notify(`[pi-subagents-lite] ${msg}`, "warning");
    else console.warn(`[pi-subagents-lite] ${msg}`);
  }

  return result;
}
