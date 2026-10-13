/**
 * agent-manager-id-resolution.test.ts — Agent id resolution (short-id prefix lookup).
 *
 * Tool input is resolved with matchAgents(); internal lookups (getRecord)
 * stay exact-match.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { fakeCtx, fakePi, makeResolvablePromise } from "../fixtures.js";
import { mockModules, type OnAgentComplete } from "./manager-mocks.js";
import { AgentManager } from "../../src/agents/agent-manager.js";
import { SHORT_ID_LENGTH } from "../../src/types.js";

describe("AgentManager id resolution", () => {
  let manager: AgentManager;
  let onComplete: Mock<OnAgentComplete>;

  beforeEach(() => {
    mockModules.resetUuidCounter();
    mockModules.mockRunAgent.mockReset();
    mockModules.mockContinueAgentSession.mockReset();
    mockModules.mockRunAgent.mockReturnValue(makeResolvablePromise().promise);
    onComplete = vi.fn<OnAgentComplete>();
    manager = new AgentManager(onComplete);
  });

  afterEach(() => {
    void manager?.dispose();
  });

  function spawn(prompt: string): string {
    return manager.spawn(fakePi(), fakeCtx(), "general-purpose", prompt, { description: prompt });
  }

  function shortId(id: string): string {
    return id.slice(0, SHORT_ID_LENGTH);
  }

  it("returns the record for an exact id", () => {
    const id = spawn("first");

    expect(manager.matchAgents(id)).toEqual([manager.getRecord(id)!]);
  });

  it("resolves the short id form shown in tool output to its record", () => {
    const id = spawn("first");

    expect(manager.matchAgents(shortId(id))).toEqual([manager.getRecord(id)!]);
  });

  it("resolves a short id to that record alone while others are retained", () => {
    const first = spawn("first");
    const second = spawn("second");

    expect(manager.matchAgents(shortId(second))).toEqual([manager.getRecord(second)!]);
    expect(shortId(first)).not.toBe(shortId(second));
  });

  it("returns every candidate for an ambiguous prefix and resolves none of them", () => {
    const first = spawn("first");
    const second = spawn("second");
    const shared = first.slice(0, SHORT_ID_LENGTH - 1);
    expect(shared).toBe(second.slice(0, SHORT_ID_LENGTH - 1));

    expect(manager.matchAgents(shared)).toEqual([manager.getRecord(first)!, manager.getRecord(second)!]);
  });

  it("returns nothing for an id no record matches", () => {
    spawn("first");

    expect(manager.matchAgents("ffffffff")).toEqual([]);
  });

  it("rejects a blank id instead of matching every retained record", () => {
    spawn("first");
    spawn("second");

    expect(manager.matchAgents("")).toEqual([]);
  });

  it("rejects a whitespace-only id instead of matching every retained record", () => {
    spawn("first");

    expect(manager.matchAgents("   ")).toEqual([]);
  });

  it("keeps getRecord exact-match so internal callers never act on a prefix", () => {
    const id = spawn("first");

    expect(manager.getRecord(shortId(id))).toBeUndefined();
  });
});
