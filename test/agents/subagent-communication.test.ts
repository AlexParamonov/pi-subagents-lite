import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../../src/agents/agent-manager.js";
import { makeAgentRecord, fakeCtx, shellMock } from "../fixtures.js";
import { asAgentSession, asExtensionAPI } from "../pi-boundaries.js";
import { withSubagentParent, type SubagentParentContext } from "../../src/agents/subagent-context.js";

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn<ExtensionAPI["sendMessage"]>(),
  isIdle: vi.fn(() => false),
  steer: vi.fn<AgentManager["steer"]>(),
  getRecord: vi.fn<AgentManager["getRecord"]>(),
  promoteToBackground: vi.fn(),
  listAgents: vi.fn<AgentManager["listAgents"]>(),
  matchAgents: vi.fn<AgentManager["matchAgents"]>(),
}));

vi.mock("../../src/shell.js", () =>
  shellMock({
    pi: { sendMessage: mocks.sendMessage },
    sessionCtx: { isIdle: mocks.isIdle },
    manager: {
      steer: mocks.steer,
      getRecord: mocks.getRecord,
      listAgents: mocks.listAgents,
      matchAgents: mocks.matchAgents,
    },
    store: { agent: { agentStatusLimit: 8 } },
  }),
);

import extension from "../../src/index.js";
import { setPiInstance, setSessionCtx } from "../../src/shell.js";

const registerTool = vi.fn<ExtensionAPI["registerTool"]>();
const child = asExtensionAPI({ registerTool });
let childParent: SubagentParentContext;
const senderCtx: ExtensionToolContext = {
  ...fakeCtx(),
  tools: [],
  executeTool: vi.fn<ExtensionToolContext["executeTool"]>(),
};

function tool(name: string) {
  const definition = registerTool.mock.calls.map(([definition]) => definition).find((tool) => tool.name === name);
  if (!definition) throw new Error(`Tool ${name} not registered`);
  return definition;
}

function message(params: Record<string, unknown>) {
  return tool("MessageAgent").execute("call-1", params, undefined, undefined, senderCtx);
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.isIdle.mockReturnValue(false);
  mocks.steer.mockResolvedValue(true);
  mocks.getRecord.mockReturnValue(undefined);
  mocks.promoteToBackground.mockReset();
  mocks.listAgents.mockReturnValue([]);
  mocks.matchAgents.mockReturnValue([]);
  const parentPi = asExtensionAPI({ sendMessage: mocks.sendMessage });
  const parentCtx = fakeCtx({ isIdle: mocks.isIdle });
  setPiInstance(parentPi);
  setSessionCtx(parentCtx);
  childParent = {
    pi: parentPi,
    ctx: parentCtx,
    manager: {
      getRecord: mocks.getRecord,
      listAgents: mocks.listAgents,
      matchAgents: mocks.matchAgents,
      steer: mocks.steer,
    },
    agentId: "97a7e0e6-4000-400",
    agentStatusLimit: 8,
    onBackgroundPromotion: mocks.promoteToBackground,
  };
  await withSubagentParent(childParent, () => extension(child));
});

describe("subagent communication tools", () => {
  it.each([undefined, null])("messages a busy parent when agent_id is %s", async (agent_id) => {
    const result = await message({ ...(agent_id === undefined ? {} : { agent_id }), message: "  Need guidance\n" });

    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    const [payload, delivery] = mocks.sendMessage.mock.calls[0]!;
    expect(payload.content).toContain("Need guidance");
    expect(delivery).toMatchObject({ deliverAs: "steer", triggerTurn: true });
    expect(result.isError).toBeUndefined();
    expect(mocks.steer).not.toHaveBeenCalled();
    expect(mocks.promoteToBackground).toHaveBeenCalled();
  });

  it("attaches the originating agent data to the parent message", async () => {
    const record = makeAgentRecord({
      id: "97a7e0e6-4000-400",
      display: { type: "general-purpose", description: "Add cancellable build subprocess scopes" },
      execution: {
        session: asAgentSession({
          sessionManager: senderCtx.sessionManager,
          model: senderCtx.model,
          thinkingLevel: "high",
        }),
      },
    });
    mocks.getRecord.mockReturnValue(record);
    await message({ message: "Lorem ipsum" });
    expect(mocks.sendMessage.mock.calls[0]?.[0].details).toMatchObject({
      sender: "test-session",
      type: record.display.type,
      description: record.display.description,
      modelName: "Test Model",
      modelId: "model",
      thinkingLevel: "high",
      turnCount: 1,
      toolUses: 0,
      input: 0,
      output: 0,
      durationMs: expect.any(Number),
    });
  });

  it("wakes an idle parent instead of dropping steering input", async () => {
    mocks.isIdle.mockReturnValue(true);
    await message({ message: "Ready for review" });
    expect(mocks.sendMessage.mock.calls[0]?.[1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("does not redirect an old child's message into a replacement parent runtime", async () => {
    const replacement = vi.fn<ExtensionAPI["sendMessage"]>();
    setPiInstance(asExtensionAPI({ sendMessage: replacement }));
    setSessionCtx(fakeCtx({ isIdle: () => true }));
    await message({ message: "Still working" });
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.sendMessage.mock.calls[0]?.[1]?.deliverAs).toBe("steer");
    expect(replacement).not.toHaveBeenCalled();
  });

  it("surfaces delivery failures rather than claiming success", async () => {
    mocks.sendMessage.mockImplementationOnce(() => {
      throw new Error("Parent disposed");
    });
    await expect(message({ message: "Help" })).rejects.toThrow("Parent disposed");
  });

  it.each([undefined, "", " \n "])("rejects an empty message %s", async (messageText) => {
    await expect(message({ message: messageText })).rejects.toThrow("message is required");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps explicit IDs routed through the manager", async () => {
    const target = makeAgentRecord({ id: "abc123de-4000-400" });
    mocks.matchAgents.mockReturnValue([target]);
    const result = await message({ agent_id: "abc123de", message: " Review tests " });
    expect(mocks.steer).toHaveBeenCalledExactlyOnceWith(target.id, "Review tests");
    expect(result.isError).toBeUndefined();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("does not treat a blank explicit ID as the parent", async () => {
    await expect(message({ agent_id: " ", message: "Help" })).rejects.toThrow("agent_id is required");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("includes the parent's managed agent state", async () => {
    mocks.listAgents.mockReturnValue([makeAgentRecord({ id: "abc123de-4000-400" })]);
    const result = await tool("AgentStatus").execute("status-1", {}, undefined, undefined, senderCtx);
    const content = result.content[0];
    if (content.type !== "text") throw new Error("Expected status text");
    const output = content.text;

    expect(output).toContain("abc123de");
    expect(output).toContain("running");
    expect(result.isError).toBeUndefined();
  });
});
