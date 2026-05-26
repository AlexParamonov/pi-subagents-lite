/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 *
 * Forked from upstream pi-subagents. Key modifications:
 *   - Removed buildParentContext import and inheritContext code path
 *   - Removed buildMemoryBlock/buildReadOnlyMemoryBlock imports and memory code paths
 *   - Replaced import { detectEnv } from env.ts with inline git detection via pi.exec()
 *   - Handles `isolated` parameter internally (sets extensions=false, skills=false)
 *   - RunOptions: keeps pi: ExtensionAPI, isolated?: boolean. Removes inheritContext, isolation
 *   - PromptExtras: removed memoryBlock — keeps skillBlocks[] only
 *   - EXCLUDED_TOOL_NAMES prevents sub-subagent spawning
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getAgentConfig, getConfig, getToolNamesForType } from "./agent-types.js";
import { extractText } from "./context.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { buildAgentPrompt, type PromptExtras } from "./prompts.js";
import { preloadSkills } from "./skill-loader.js";
import type { EnvInfo, SubagentType, ThinkingLevel } from "./types.js";

/** Names of tools registered by this extension that subagents must NOT inherit. */
export const EXCLUDED_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent"];

/** Additional turns allowed after the soft limit steer message. */
const GRACE_TURNS = 5;

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}

/**
 * Try to find the right model for an agent type.
 * Priority: explicit option > config.model > parent model.
 */
function resolveDefaultModel(
  parentModel: Model<any> | undefined,
  registry: { find(provider: string, modelId: string): Model<any> | undefined },
  configModel?: string,
): Model<any> | undefined {
  if (configModel) {
    const slashIdx = configModel.indexOf("/");
    if (slashIdx !== -1) {
      const provider = configModel.slice(0, slashIdx);
      const modelId = configModel.slice(slashIdx + 1);
      const found = registry.find(provider, modelId);
      if (found) return found;
    }
  }

  return parentModel;
}

/** Info about a tool event in the subagent. */
export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
}

interface RunOptions {
  /** ExtensionAPI instance — used for pi.exec() for git detection. */
  pi: ExtensionAPI;
  /** Manager-assigned id; suffixes session name to disambiguate parallel spawns (e.g. `Explore#a1b2c3d4`). */
  agentId?: string;
  model?: Model<any>;
  maxTurns?: number;
  signal?: AbortSignal;
  /** When true, agent gets only built-in tools (no extensions, no skills). */
  isolated?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Override working directory. */
  cwd?: string;
  /** Called on tool start/end with activity info. */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /**
   * Called once per assistant message_end with that message's usage delta.
   * Lets callers maintain a lifetime accumulator that survives compaction
   * (which replaces session.state.messages and resets stats-derived sums).
   */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /**
   * Called when the session successfully compacts. `tokensBefore` is upstream's
   * pre-compaction context size estimate. Aborted compactions don't fire.
   */
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
}

interface RunResult {
  responseText: string;
  session: AgentSession;
  /** True if the agent was hard-aborted (max_turns + grace exceeded). */
  aborted: boolean;
  /** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
  steered: boolean;
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
 * Subscribe to shared session events (tool activity, usage, compaction)
 * used by both runAgent and resumeAgent. Returns an unsubscribe function.
 */
function subscribeToSessionEvents(
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
      const u = (event.message as any).usage;
      if (u) {
        options.onAssistantUsage?.({
          input: u.input ?? 0,
          output: u.output ?? 0,
          cacheWrite: u.cacheWrite ?? 0,
        });
      }
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
    }
  });
}

/**
 * Filter active tools: remove extension tools to prevent nesting,
 * apply extension allowlist if specified, and apply disallowedTools denylist.
 * Returns null when no filtering is needed (isolated mode with no denylist).
 */
function filterActiveTools(
  activeTools: string[],
  builtinToolNames: string[],
  extensions: true | string[] | false,
  disallowedTools?: string[],
): string[] | null {
  const disallowedSet = disallowedTools ? new Set(disallowedTools) : undefined;

  if (extensions === false) {
    // Isolated mode — only apply denylist to built-in tools
    if (!disallowedSet) return null;
    const filtered = activeTools.filter(t => !disallowedSet.has(t));
    return filtered.length !== activeTools.length ? filtered : null;
  }

  const builtinToolNameSet = new Set(builtinToolNames);
  return activeTools.filter((t) => {
    if (EXCLUDED_TOOL_NAMES.includes(t)) return false;
    if (disallowedSet?.has(t)) return false;
    if (builtinToolNameSet.has(t)) return true;
    if (Array.isArray(extensions)) {
      return extensions.some(ext => t.startsWith(ext) || t.includes(ext));
    }
    return true;
  });
}

/** Run a git command via pi.exec, returning stdout on success or null on failure. */
async function execGit(pi: ExtensionAPI, args: string[], cwd: string): Promise<string | null> {
  try {
    const result = await pi.exec("git", args, { cwd, timeout: 5000 });
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

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  const config = getConfig(type);
  const agentConfig = getAgentConfig(type);

  // Resolve working directory
  const effectiveCwd = options.cwd ?? ctx.cwd;

  const env = await detectEnv(options.pi, effectiveCwd);

  // Resolve extensions/skills: isolated overrides to false
  const extensions = options.isolated ? false : config.extensions;
  const skills = options.isolated ? false : config.skills;

  // Build prompt extras (no memoryBlock — skills only).
  // When skills is string[], preload their content into the prompt.
  const extras: PromptExtras = Array.isArray(skills)
    ? { skillBlocks: preloadSkills(skills, effectiveCwd) }
    : {};

  const toolNames = getToolNamesForType(type);

  // Build system prompt from agent config
  let systemPrompt: string;
  if (agentConfig) {
    systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, extras);
  } else {
    // Unknown type fallback: spread the canonical general-purpose config
    const fallback = DEFAULT_AGENTS.get("general-purpose");
    if (!fallback) throw new Error(`No fallback config available for unknown type "${type}"`);
    systemPrompt = buildAgentPrompt({ ...fallback, name: type }, effectiveCwd, env, extras);
  }

  // When skills is string[], they're already preloaded into the prompt.
  // Pass noSkills: true to prevent the skill loader from loading them again.
  const skipSkillLoader = skills === false || Array.isArray(skills);

  const agentDir = getAgentDir();

  // Load extensions/skills: true or string[] → load; false → don't.
  const loader = new DefaultResourceLoader({
    cwd: effectiveCwd,
    agentDir,
    noExtensions: extensions === false,
    noSkills: skipSkillLoader,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  // Resolve model: explicit option > config.model > parent model
  const model = options.model ?? resolveDefaultModel(
    ctx.model, ctx.modelRegistry, agentConfig?.model,
  );

  // Resolve thinking level: explicit option > agent config > undefined (inherit)
  const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking;

  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    cwd: effectiveCwd,
    agentDir,
    sessionManager: SessionManager.inMemory(effectiveCwd),
    settingsManager: SettingsManager.create(effectiveCwd, agentDir),
    modelRegistry: ctx.modelRegistry,
    model,
    tools: toolNames,
    resourceLoader: loader,
  };
  if (thinkingLevel) {
    sessionOpts.thinkingLevel = thinkingLevel;
  }

  const { session } = await createAgentSession(sessionOpts);

  const baseSessionName = agentConfig?.name ?? type;
  session.setSessionName(
    options.agentId ? `${baseSessionName}#${options.agentId.slice(0, 8)}` : baseSessionName,
  );

  // Filter active tools: remove our own tools to prevent nesting,
  // apply extension allowlist if specified, and apply disallowedTools denylist
  const filteredTools = filterActiveTools(
    session.getActiveToolNames(),
    toolNames,
    extensions,
    agentConfig?.disallowedTools,
  );
  if (filteredTools) {
    session.setActiveToolsByName(filteredTools);
  }

  // Bind extensions so that session_start fires and extensions can initialize
  await session.bindExtensions({
    onError: (err) => {
      options.onToolActivity?.({
        type: "end",
        toolName: `extension-error:${err.extensionPath}`,
      });
    },
  });

  options.onSessionCreated?.(session);

  // Track turns for graceful max_turns enforcement
  let turnCount = 0;
  const maxTurns = normalizeMaxTurns(options.maxTurns ?? agentConfig?.maxTurns);
  let softLimitReached = false;
  let aborted = false;

  const unsubEvents = subscribeToSessionEvents(session, options);

  const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      turnCount++;
      options.onTurnEnd?.(turnCount);
      if (maxTurns == null) return;
      if (!softLimitReached && turnCount >= maxTurns) {
        softLimitReached = true;
        session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
      } else if (softLimitReached && turnCount >= maxTurns + GRACE_TURNS) {
        aborted = true;
        session.abort();
      }
    }
  });

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

  const responseText = collector.getText().trim() || getLastAssistantText(session);
  return { responseText, session, aborted, steered: softLimitReached };
}

/**
 * Send a new prompt to an existing session (resume).
 */
export async function resumeAgent(
  session: AgentSession,
  prompt: string,
  options: Pick<RunOptions, "onToolActivity" | "onAssistantUsage" | "onCompaction"> & { signal?: AbortSignal } = {},
): Promise<string> {
  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);
  const unsubEvents = subscribeToSessionEvents(session, options);

  try {
    await session.prompt(prompt);
  } finally {
    collector.unsubscribe();
    unsubEvents();
    cleanupAbort();
  }

  return collector.getText().trim() || getLastAssistantText(session);
}

/**
 * Send a steering message to a running subagent.
 * The message will interrupt the agent after its current tool execution.
 */
export async function steerAgent(
  session: AgentSession,
  message: string,
): Promise<void> {
  await session.steer(message);
}




