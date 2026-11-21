import { expect } from "vite-plus/test";

/** With real timers, check that the workflow completion gate has not opened. */
export async function expectGatePending(gate: Promise<unknown>, reason?: string): Promise<void> {
  // A bare fallback would win before an already-open gate's reaction reaches the race. Waiting
  // until the next task lets an opened gate fail the assertion.
  const state = await Promise.race([
    gate.then(() => "opened"),
    new Promise<string>((resolve) => setTimeout(resolve, 0, "pending")),
  ]);
  expect(state, reason).toBe("pending");
}
