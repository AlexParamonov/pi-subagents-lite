import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vite-plus/test";
import extension from "../../src/index.ts";
import { disposeChildSession } from "../../src/agents/session-teardown.ts";
import { getCoordinator } from "../../src/shell.ts";
import { makeAgentRecord } from "../fixtures.ts";
import { beforeEnd, deferred } from "../workflows/fixtures.ts";

const provider = "nudge-contract";
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const answers = ["The offline subagent found a match.", "The other subagent verified it."];

it.each([
  { scenario: "normal finish", late: false, interrupt: false, requests: [false, true] },
  { scenario: "settling after the turn boundary", late: true, interrupt: false, requests: [false, true] },
  { scenario: "Esc", late: false, interrupt: true, requests: [false] },
])("delivers each result once when the busy parent reaches $scenario", async ({ late, interrupt, requests }) => {
  const cwd = mkdtempSync(join(tmpdir(), "subagents-nudge-contract-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

  const entered = deferred<void>();
  const release = deferred<void>();
  const settling = deferred<void>();
  const finishSettling = deferred<void>();
  const sawAnswers: boolean[] = [];
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      extension,
      (pi) => {
        if (late) {
          pi.on("agent_before_settle", async () => {
            settling.resolve();
            await finishSettling.promise;
          });
        }
        pi.registerProvider(provider, {
          api: provider,
          apiKey: "unused-test-value",
          baseUrl: "http://localhost",
          models: [
            {
              id: provider,
              name: provider,
              reasoning: false,
              input: ["text"],
              cost,
              contextWindow: 8192,
              maxTokens: 128,
            },
          ],
          streamSimple(model, context, options) {
            const first = sawAnswers.length === 0;
            const contextText = JSON.stringify(context.messages);
            sawAnswers.push(answers.every((answer) => contextText.includes(answer)));
            const stream = createAssistantMessageEventStream();
            const message: AssistantMessage = {
              role: "assistant",
              model: model.id,
              provider: model.provider,
              api: model.api,
              content: [{ type: "text", text: "Finished." }],
              stopReason: "stop",
              usage: { ...cost, totalTokens: 0, cost: { ...cost, total: 0 } },
              timestamp: Date.now(),
            };
            const finish = () => {
              if (options?.signal?.aborted) {
                stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } });
              } else {
                stream.push({ type: "done", reason: "stop", message });
              }
            };
            stream.push({ type: "start", partial: message });
            if (first) {
              entered.resolve();
              void release.promise.then(finish);
            } else {
              finish();
            }
            return stream;
          },
        });
      },
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "all",
  });

  try {
    await session.bindExtensions({});
    const model = session.modelRuntime.getModel(provider, provider);
    expect(model).toBeDefined();
    await session.setModel(model!);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const prompting = session.prompt("Check the task.");
    await beforeEnd(entered.promise, prompting, "the provider's first request");
    if (late) {
      release.resolve();
      await beforeEnd(settling.promise, prompting, "the parent's final settle hook");
    }
    const coordinator = getCoordinator()!;
    for (const result of answers) {
      const record = makeAgentRecord({ id: crypto.randomUUID(), result, lifecycle: { status: "completed" } });
      coordinator.enrollForNudge(record.id);
      coordinator.onAgentComplete(record);
    }
    await vi.advanceTimersByTimeAsync(200);

    let aborting: Promise<void> | undefined;
    if (interrupt) {
      session.clearQueue();
      aborting = session.abort();
    }
    release.resolve();
    finishSettling.resolve();
    await prompting;
    await aborting;

    const deliveries = session.sessionManager
      .getBranch()
      .flatMap((entry) =>
        entry.type === "custom_message" && entry.customType === "subagent-result" ? [entry.content] : [],
      );
    expect(deliveries).toEqual(answers.map((answer) => expect.stringContaining(answer)));
    expect(sawAnswers).toEqual(requests);
  } finally {
    release.resolve();
    finishSettling.resolve();
    await disposeChildSession(session);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  }
});
