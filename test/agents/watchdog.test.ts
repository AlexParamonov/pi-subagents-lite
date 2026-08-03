/**
 * watchdog.test.ts — Tests for the Watchdog stuck-agent detection state machine.
 *
 * The Watchdog is pure and clock-injectable: feed it tool activity / text
 * deltas, advance the fake clock, and assert the stop decisions it returns.
 */
import { describe, it, expect } from "vitest";
import { Watchdog } from "../../src/agents/watchdog.js";

const MIN = 60_000;

/** Mutable fake clock for deterministic elapsed-time tests. */
function makeClock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const alwaysRunning = () => true;

describe("Watchdog", () => {
  it("records no decision when both checks are disabled (0)", () => {
    const clock = makeClock();
    const wd = new Watchdog(clock.now);
    wd.start("a1");
    wd.recordActivity("a1", { type: "start", toolName: "bash", toolCallId: "c1" });
    clock.advance(10 * MIN);
    expect(wd.check(0, 0, alwaysRunning)).toEqual(new Map());
  });

  it("stops a tool call that exceeds the tool timeout, with tool name and elapsed", () => {
    const clock = makeClock();
    const wd = new Watchdog(clock.now);
    wd.start("a1");
    wd.recordActivity("a1", { type: "start", toolName: "bash", toolCallId: "c1" });
    clock.advance(45 * MIN);
    expect(wd.check(45 * MIN, 0, alwaysRunning).get("a1")).toEqual({
      kind: "tool",
      toolName: "bash",
      elapsedMs: 45 * MIN,
    });
  });

  it("clears a tool call on end so a completed call never triggers", () => {
    const clock = makeClock();
    const wd = new Watchdog(clock.now);
    wd.start("a1");
    wd.recordActivity("a1", { type: "start", toolName: "bash", toolCallId: "c1" });
    clock.advance(10 * MIN);
    wd.recordActivity("a1", { type: "end", toolName: "bash", toolCallId: "c1" });
    clock.advance(40 * MIN);
    expect(wd.check(45 * MIN, 0, alwaysRunning).size).toBe(0);
  });

  it("clears a tool call on an end event without toolCallId by name match", () => {
    const clock = makeClock();
    const wd = new Watchdog(clock.now);
    wd.start("a1");
    wd.recordActivity("a1", { type: "start", toolName: "bash", toolCallId: "c1" });
    clock.advance(10 * MIN);
    // Synthetic end events (e.g. extension-error) carry no toolCallId.
    wd.recordActivity("a1", { type: "end", toolName: "bash" });
    clock.advance(40 * MIN);
    expect(wd.check(45 * MIN, 0, alwaysRunning).size).toBe(0);
  });

  it("tracks parallel same-name tool calls independently by toolCallId", () => {
    const clock = makeClock();
    const wd = new Watchdog(clock.now);
    wd.start("a1");
    wd.recordActivity("a1", { type: "start", toolName: "bash", toolCallId: "c1" });
    clock.advance(10 * MIN);
    wd.recordActivity("a1", { type: "start", toolName: "bash", toolCallId: "c2" });
    wd.recordActivity("a1", { type: "end", toolName: "bash", toolCallId: "c1" });
    clock.advance(35 * MIN);
    // Only c2 is still running, and only for 35m — under the 45m threshold.
    expect(wd.check(45 * MIN, 0, alwaysRunning).size).toBe(0);
    clock.advance(11 * MIN);
    expect(wd.check(45 * MIN, 0, alwaysRunning).get("a1")).toEqual({
      kind: "tool",
      toolName: "bash",
      elapsedMs: 46 * MIN,
    });
  });

  it("stops an agent with no activity for the idle timeout", () => {
    const clock = makeClock();
    const wd = new Watchdog(clock.now);
    wd.start("a1");
    clock.advance(45 * MIN);
    expect(wd.check(0, 45 * MIN, alwaysRunning).get("a1")).toEqual({
      kind: "idle",
      elapsedMs: 45 * MIN,
    });
  });

  it("resets the idle clock on tool events and streamed text", () => {
    const clock = makeClock();
    const wd = new Watchdog(clock.now);
    wd.start("a1");
    clock.advance(10 * MIN);
    wd.recordActivity("a1", { type: "start", toolName: "read", toolCallId: "c1" });
    wd.recordActivity("a1", { type: "end", toolName: "read", toolCallId: "c1" });
    clock.advance(10 * MIN);
    wd.recordText("a1");
    clock.advance(44 * MIN);
    expect(wd.check(0, 45 * MIN, alwaysRunning).size).toBe(0);
    clock.advance(2 * MIN);
    expect(wd.check(0, 45 * MIN, alwaysRunning).get("a1")).toEqual({
      kind: "idle",
      elapsedMs: 46 * MIN,
    });
  });

  it("idle check still applies while a tool runs when the tool check is disabled", () => {
    const clock = makeClock();
    const wd = new Watchdog(clock.now);
    wd.start("a1");
    wd.recordActivity("a1", { type: "start", toolName: "bash", toolCallId: "c1" });
    clock.advance(45 * MIN);
    expect(wd.check(0, 45 * MIN, alwaysRunning).get("a1")).toEqual({
      kind: "idle",
      elapsedMs: 45 * MIN,
    });
  });

  it("prefers the tool decision when both checks fire at the same instant", () => {
    const clock = makeClock();
    const wd = new Watchdog(clock.now);
    wd.start("a1");
    wd.recordActivity("a1", { type: "start", toolName: "bash", toolCallId: "c1" });
    clock.advance(45 * MIN);
    expect(wd.check(45 * MIN, 45 * MIN, alwaysRunning).get("a1")).toEqual({
      kind: "tool",
      toolName: "bash",
      elapsedMs: 45 * MIN,
    });
  });

  it("tracks agents independently", () => {
    const clock = makeClock();
    const wd = new Watchdog(clock.now);
    wd.start("a1");
    wd.start("a2");
    wd.recordActivity("a1", { type: "start", toolName: "bash", toolCallId: "c1" });
    clock.advance(45 * MIN);
    const decisions = wd.check(45 * MIN, 0, alwaysRunning);
    expect(decisions.get("a1")).toEqual({ kind: "tool", toolName: "bash", elapsedMs: 45 * MIN });
    expect(decisions.has("a2")).toBe(false);
  });

  it("drops state for agents that are no longer running", () => {
    const clock = makeClock();
    const wd = new Watchdog(clock.now);
    wd.start("a1");
    wd.recordActivity("a1", { type: "start", toolName: "bash", toolCallId: "c1" });
    clock.advance(10 * MIN);
    expect(wd.check(45 * MIN, 0, () => false).size).toBe(0);
    // Pruned state can no longer fire, even if the agent is running again.
    clock.advance(40 * MIN);
    expect(wd.check(45 * MIN, 0, alwaysRunning).size).toBe(0);
  });

  it("ignores activity for unknown agents", () => {
    const clock = makeClock();
    const wd = new Watchdog(clock.now);
    wd.recordActivity("ghost", { type: "start", toolName: "bash", toolCallId: "c1" });
    wd.recordText("ghost");
    clock.advance(45 * MIN);
    expect(wd.check(45 * MIN, 45 * MIN, alwaysRunning).size).toBe(0);
  });
});
