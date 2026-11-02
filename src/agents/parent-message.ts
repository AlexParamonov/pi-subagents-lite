import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildAgentDetails } from "./tool-execution.ts";
import type { SubagentParentContext } from "./subagent-context.ts";

export interface SubagentMessageDetails extends Record<string, unknown> {
  sender?: string;
  type?: string;
  description?: string;
  modelName?: string;
  modelId?: string;
  thinkingLevel?: string;
}

/** Deliver to the captured parent runtime, not whichever session now owns the shell. */
export async function sendParentMessage(
  parent: SubagentParentContext,
  senderCtx: ExtensionContext,
  message: unknown,
): Promise<AgentToolResult<undefined>> {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) throw new Error("message is required");

  const sender = senderCtx.sessionManager.getSessionName() ?? senderCtx.sessionManager.getSessionId();
  const record = parent.manager?.getRecord(parent.agentId ?? "");
  const model = record?.execution.session?.model ?? senderCtx.model;
  const thinking =
    record?.execution.session?.thinkingLevel ?? record?.display.invocation?.thinkingLevel ?? senderCtx.thinkingLevel;
  const details: SubagentMessageDetails = {
    sender,
    ...(record
      ? {
          ...buildAgentDetails(record, { includeStats: true }),
          type: record.display.type,
          description: record.display.description,
          durationMs: Math.max(0, (record.lifecycle.completedAt ?? Date.now()) - record.lifecycle.startedAt),
        }
      : {}),
    ...(model ? { modelName: model.name, modelId: model.id } : {}),
    ...(thinking ? { thinkingLevel: thinking } : {}),
  };
  parent.pi.sendMessage(
    {
      customType: "subagent-message",
      content: `[Subagent "${sender}" message]\n\n${text}`,
      details,
      display: true,
    },
    {
      deliverAs: parent.ctx.isIdle() ? "followUp" : "steer",
      triggerTurn: true,
    },
  );
  return {
    content: [{ type: "text", text: "Submitted to parent; delivery is not acknowledged" }],
    details: undefined,
  };
}
