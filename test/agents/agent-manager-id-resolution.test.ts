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

  function matchedIds(id: string): string[] {
    return manager.matchAgents(id).map((record) => record.id);
  }

  it("returns the record for an exact id", () => {
    const id = spawn("first");

    expect(matchedIds(id)).toEqual([id]);
  });

  it("resolves a short id to that record alone while others are retained", () => {
    const first = spawn("first");
    const second = spawn("second");
    expect(shortId(first)).not.toBe(shortId(second));

    expect(matchedIds(shortId(second))).toEqual([second]);
  });

  it("returns every candidate for an ambiguous prefix and resolves none of them", () => {
    const first = spawn("first");
    const second = spawn("second");
    const shared = first.slice(0, SHORT_ID_LENGTH - 1);
    expect(shared).toBe(second.slice(0, SHORT_ID_LENGTH - 1));

    expect(matchedIds(shared)).toEqual([first, second]);
  });

  it("returns no match for a blank id or an id no record carries", () => {
    spawn("first");
    spawn("second");

    for (const id of ["", "   ", "ffffffff"]) {
      expect(manager.matchAgents(id)).toEqual([]);
    }
  });

  it("keeps getRecord exact-match so internal callers never act on a prefix", () => {
    const id = spawn("first");

    expect(manager.getRecord(shortId(id))).toBeUndefined();
  });
});
