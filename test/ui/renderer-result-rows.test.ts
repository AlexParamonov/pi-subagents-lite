/**
 * renderer-result-rows.test.ts — the settled foreground result row rendered by the real pi-tui,
 * so the row count and the width behaviour are the terminal's, not a mock's.
 */

import { describe, it, expect } from "vite-plus/test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { defaultTheme } from "../mock-utils.js";
import { makeAgentRecord } from "../fixtures.js";
import { buildAgentDetails, formatResultContent } from "../../src/agents/tool-execution.js";
import { renderAgentToolResult } from "../../src/ui/renderer.js";
import type { AgentLifecycle } from "../../src/types.js";

const WIDTH = 60;

/** The rows a settled foreground Agent call produces, rendered at WIDTH. */
function rows(result: string, lifecycle: Partial<AgentLifecycle>, expanded = false): string[] {
  const record = makeAgentRecord({
    result,
    display: { description: "Fix the flaky fetch test" },
    lifecycle: { startedAt: 1000, completedAt: 61000, started: true, ...lifecycle },
  });
  const component = renderAgentToolResult(
    {
      content: [{ type: "text", text: formatResultContent(record) }],
      details: buildAgentDetails(record, { includeStats: true }),
    },
    { expanded },
    defaultTheme,
    false,
  );
  return component.render(WIDTH).map((line) => line.replace(/\s+$/, ""));
}

describe("foreground result row — rendered at terminal width", () => {
  it.each([false, true])("shows the failure reason when Pi supplies no agent details (expanded: %s)", (expanded) => {
    const component = renderAgentToolResult(
      {
        content: [{ type: "text", text: "Agent failed: \u001b[?25lmodel unavailable" }],
        details: {},
        isError: true,
      },
      { expanded },
      defaultTheme,
      false,
    );

    expect(component.render(WIDTH).map((line) => line.trimEnd())).toEqual(["✗ Agent failed: model unavailable"]);
  });

  it("keeps a first line wider than the terminal on one truncated row", () => {
    const longLine = "Vendor fetch fails on the first attempt, ".repeat(6).trim();

    const lines = rows(`${longLine}\n\nSecond paragraph.`, { status: "completed" });

    expect(lines).toHaveLength(3);
    expect(visibleWidth(lines[2])).toBeLessThanOrEqual(WIDTH);
    expect(lines[2]).toContain("Vendor fetch fails on the first");
  });

  it("renders the stats row, the description row and the reply row, in that order", () => {
    const lines = rows("Vendor fetch fails on the first attempt.\n\nIt retries twice.", { status: "completed" });

    expect(lines).toEqual([
      expect.stringContaining("·"),
      "  Fix the flaky fetch test",
      "  Vendor fetch fails on the first attempt.",
    ]);
  });

  it("shows the whole reply body and no preview row once expanded", () => {
    const lines = rows("Vendor fetch fails on the first attempt.\n\nIt retries twice.", { status: "completed" }, true);

    expect(lines).toEqual([
      expect.stringContaining("·"),
      "  Fix the flaky fetch test",
      "  Vendor fetch fails on the first attempt.",
      "",
      "  It retries twice.",
    ]);
  });

  it("renders no reply row for an agent that produced no reply text", () => {
    expect(rows("", { status: "completed" })).toEqual([expect.stringContaining("·"), "  Fix the flaky fetch test"]);
  });
});
