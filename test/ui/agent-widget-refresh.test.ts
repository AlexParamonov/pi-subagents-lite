import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { agentConfigMock } from "../agent-types-mock.js";
import { AgentWidget, type UICtx } from "../../src/ui/agent-widget.js";
import type { AgentRecord, LiveView } from "../../src/types.js";
import { asAgentSession } from "../pi-boundaries.js";
import {
  makeFinishedAgent,
  makeMockManager,
  makeMockTheme,
  makeQueuedAgent,
  makeRunningAgent,
} from "./widget-helpers.js";

vi.mock("../../src/agents/agent-types.js", () => ({ getAgentConfig: agentConfigMock() }));

type WidgetFactory = NonNullable<Parameters<UICtx["setWidget"]>[1]>;
type WidgetComponent = ReturnType<WidgetFactory>;

/** A synchronous UI host: requested frames render through the public component seam. */
function mount(
  agents: AgentRecord[],
  getLiveView: (id: string) => LiveView | undefined = () => undefined,
  configureWidget?: (widget: AgentWidget) => void,
) {
  const manager = makeMockManager(agents);
  const widget = new AgentWidget(manager, getLiveView);
  configureWidget?.(widget);
  const theme = makeMockTheme();
  let component: WidgetComponent | undefined;
  let lines: string[] = [];
  const requestRender = vi.fn(() => {
    lines = component?.render() ?? [];
  });
  const tui = { terminal: { columns: 200 }, requestRender };
  const ui = {
    setStatus: vi.fn<UICtx["setStatus"]>(),
    setWidget(_key, factory) {
      component = factory?.(tui, theme);
      lines = component?.render() ?? [];
    },
  } satisfies UICtx;
  widget.setUICtx(ui);
  widget.update();
  return {
    widget,
    manager,
    tui,
    theme,
    ui,
    requestRender,
    get lines() {
      return lines;
    },
    get component() {
      return component;
    },
  };
}

interface ContextState {
  percent: number | null;
  leaf: { id: string };
  routedModel?: { id: string; contextWindow: number };
}

function contextSession() {
  const state: ContextState = {
    percent: 40,
    leaf: { id: "leaf" },
  };
  const manager = {
    getSessionId: () => "session",
    getLeafId: () => state.leaf.id,
    getLeafEntry: () => state.leaf,
  };
  const session = asAgentSession({
    sessionManager: manager,
    model: { id: "selected", contextWindow: 1000 },
    get routedModel() {
      return state.routedModel ? { model: state.routedModel } : undefined;
    },
    getContextUsage: () => ({ percent: state.percent }),
  });
  return { state, manager, session };
}

describe("widget redraw scheduling", () => {
  const mounted: ReturnType<typeof mount>[] = [];
  const setup = (...args: Parameters<typeof mount>) => {
    const result = mount(...args);
    mounted.push(result);
    return result;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    for (const host of mounted.splice(0)) host.widget.dispose();
    vi.useRealTimers();
  });

  it("costs one record snapshot and no repaint or hidden context read on an unchanged tick", () => {
    const running = makeRunningAgent("hidden");
    const getContextUsage = vi.fn(() => ({ percent: 50 }));
    running.execution.session = asAgentSession({ getContextUsage });
    const host = setup([makeFinishedAgent("finished"), running], undefined, (widget) => widget.setMaxLines(3));
    expect(host.lines.join("\n")).toContain("+1 more");
    // The mounted theme first reaches the status bar on this update.
    host.widget.update();
    host.ui.setStatus.mockClear();
    const rows = host.lines;
    const listAgents = vi.spyOn(host.manager, "listAgents");
    host.widget.ensureTimer();

    vi.advanceTimersByTime(80);

    expect(listAgents).toHaveBeenCalledOnce();
    expect(host.requestRender).not.toHaveBeenCalled();
    expect(getContextUsage).not.toHaveBeenCalled();
    expect(host.ui.setStatus).not.toHaveBeenCalled();
    expect(host.lines).toEqual(rows);
  });

  it("shows a queued agent's new activity and spinner after it starts", () => {
    const queued = makeQueuedAgent("queued");
    const activity: LiveView = { activeTools: new Map(), responseText: "first response" };
    const host = setup([queued], () => activity);
    host.widget.ensureTimer();
    expect(host.lines.join("\n")).toContain("1 queued");

    queued.lifecycle.status = "running";
    queued.lifecycle.started = true;
    vi.advanceTimersByTime(80);
    expect(host.lines.join("\n")).toContain("first response");
    const firstFrame = host.lines;
    vi.advanceTimersByTime(80);
    expect(host.lines).not.toEqual(firstFrame);

    activity.responseText = "new response";
    vi.advanceTimersByTime(80);
    expect(host.lines.join("\n")).toContain("new response");
  });

  it("repaints when an in-place record edit or widget setting changes the finished row", () => {
    const finished = makeFinishedAgent("finished");
    const host = setup([finished]);
    finished.stats.contextPercent = 77;
    host.widget.update();
    expect(host.lines.join("\n")).toContain("77%");

    host.widget.setStatsVisibility({ showContext: false });
    host.widget.update();
    expect(host.lines.join("\n")).not.toContain("77%");
  });

  it("honors width changes and theme invalidation after static frames", () => {
    const host = setup([makeFinishedAgent("finished")]);
    const wide = host.lines;
    host.tui.terminal.columns = 30;
    host.widget.update();
    expect(host.lines).not.toEqual(wide);

    const narrow = host.lines;
    host.theme.fg = (_color, text) => text;
    host.component!.invalidate();
    host.widget.update();
    expect(host.lines).not.toEqual(narrow);
  });

  it("continues polling after expiry and clear so a continued or newly queued agent reappears", () => {
    const finished = makeFinishedAgent("finished");
    finished.lifecycle.completedAt = Date.now() - 60_000;
    const agents = [finished];
    const host = setup(agents);
    host.widget.ensureTimer();
    vi.advanceTimersByTime(80);
    expect(host.lines).toEqual([]);
    finished.lifecycle.status = "running";
    finished.lifecycle.startedAt = Date.now();
    vi.advanceTimersByTime(80);
    expect(host.lines.join("\n")).toContain("Finished agent finished");
    agents.splice(0);
    vi.advanceTimersByTime(80);
    expect(host.ui.setStatus).toHaveBeenLastCalledWith("subagents", undefined);
    agents.push(makeQueuedAgent("new"));
    vi.advanceTimersByTime(80);
    expect(host.lines.join("\n")).toContain("1 queued");
  });

  it("re-ranks finished navigation rows after the freeze window without a running spinner", () => {
    const running = makeRunningAgent("running");
    const finished = makeFinishedAgent("finished");
    const host = setup([running, finished]);
    host.widget.navActivate();
    host.widget.navDown();
    running.lifecycle.status = "completed";
    running.lifecycle.completedAt = Date.now();
    host.widget.ensureTimer();
    vi.advanceTimersByTime(80);
    expect(host.lines[1]).toContain("Finished agent finished");
    expect(host.lines[2]).toMatch(/^→ /);
    vi.setSystemTime(Date.now() + 2_000);
    vi.advanceTimersByTime(80);
    expect(host.lines[1]).toMatch(/^→ /);
    expect(host.lines[2]).toContain("Finished agent finished");
  });

  it("does not suppress fresh component renders triggered by the host", () => {
    const finished = makeFinishedAgent("finished");
    const host = setup([finished]);
    finished.display.description = "updated outside the widget timer";
    expect(host.component?.render().join("\n")).toContain("updated outside the widget timer");
  });

  it("refreshes the displayed context as a sample ages or the clock rolls back", () => {
    const { state, session } = contextSession();
    const running = makeRunningAgent("running");
    running.execution.session = session;
    const host = setup([running]);
    expect(host.lines.join("\n")).toContain("40%");

    state.percent = 90;
    vi.setSystemTime(Date.now() + 500);
    host.widget.update();
    expect(host.lines.join("\n")).toContain("90%");

    state.percent = 30;
    vi.setSystemTime(Date.now() - 1_000);
    host.widget.update();
    expect(host.lines.join("\n")).toContain("30%");
  });

  it("reflects a new transcript leaf and post-compaction context without waiting for sample expiry", () => {
    const { state, session } = contextSession();
    const running = makeRunningAgent("running");
    running.execution.session = session;
    const host = setup([running]);
    expect(host.lines.join("\n")).toContain("40%");

    state.leaf = { id: "leaf" }; // A reload can replace the entry without changing its id.
    state.percent = 60;
    host.widget.update();
    expect(host.lines.join("\n")).toContain("60%");

    state.percent = null;
    running.stats.compactionCount++;
    host.widget.update();
    expect(host.lines.join("\n")).not.toContain("60%");
  });

  it("shows the context of a changed routed model or session immediately", () => {
    const { state, session } = contextSession();
    state.routedModel = { id: "physical", contextWindow: 4000 };
    const running = makeRunningAgent("running");
    running.execution.session = session;
    const host = setup([running]);
    expect(host.lines.join("\n")).toContain("40%");

    state.percent = 20;
    state.routedModel.contextWindow = 8_000;
    host.widget.update();
    expect(host.lines.join("\n")).toContain("20%");

    const replacement = contextSession();
    replacement.state.percent = 25;
    running.execution.session = replacement.session;
    host.widget.update();
    expect(host.lines.join("\n")).toContain("25%");
  });

  it("shows live context when the SDK supplies no branch stamp or throws reading it", () => {
    const running = makeRunningAgent("running");
    running.execution.session = asAgentSession({ getSessionStats: () => ({ contextUsage: { percent: 20 } }) });
    const host = setup([running]);
    expect(host.lines.join("\n")).toContain("20%");

    const source = contextSession();
    source.manager.getLeafId = () => {
      throw new Error("stamp unavailable");
    };
    running.execution.session = source.session;
    host.widget.update();
    expect(host.lines.join("\n")).toContain("40%");
  });

  it("keeps selection moving after a live-view failure", () => {
    const agents = [makeQueuedAgent("first")];
    let failOnce = true;
    const host = setup(
      agents,
      () => {
        if (failOnce) {
          failOnce = false;
          throw new Error("temporary live view failure");
        }
        return undefined;
      },
      (widget) => widget.navActivate(),
    );
    host.requestRender.mockImplementation(() => {});
    const second = makeRunningAgent("second");
    agents.push(second);
    host.widget.navDown();

    expect(host.widget.navSelect()).toBe(second);
  });
});
