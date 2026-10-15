import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
function mount(agents: AgentRecord[], getLiveView: (id: string) => LiveView | undefined = () => undefined) {
  const widget = new AgentWidget(makeMockManager(agents), getLiveView);
  const theme = makeMockTheme();
  let component: WidgetComponent | undefined;
  let lines: string[] = [];
  const requestRender = vi.fn(() => {
    lines = component?.render() ?? [];
  });
  const tui = { terminal: { columns: 200 }, requestRender };
  const ui: UICtx = {
    setStatus: vi.fn<UICtx["setStatus"]>(),
    setWidget: vi.fn<UICtx["setWidget"]>((_key, factory) => {
      component = factory?.(tui, theme);
      lines = component?.render() ?? [];
    }),
  };
  widget.setUICtx(ui);
  widget.update();
  return {
    widget,
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
  sessionId: string;
  leaf: { id: string };
  model: { id: string; contextWindow: number };
  routedModel?: { id: string; contextWindow: number };
}

function contextSession() {
  const state: ContextState = {
    percent: 40,
    sessionId: "session",
    leaf: { id: "leaf" },
    model: { id: "selected", contextWindow: 1000 },
  };
  const manager = {
    getSessionId: () => state.sessionId,
    getLeafId: () => state.leaf.id,
    getLeafEntry: () => state.leaf,
  };
  const getContextUsage = vi.fn(() => ({
    tokens: 400,
    contextWindow: state.model.contextWindow,
    percent: state.percent,
  }));
  const getSessionStats = vi.fn(() => {
    throw new Error("full session statistics must not be queried");
  });
  const session = asAgentSession({
    sessionManager: manager,
    get model() {
      return state.model;
    },
    get routedModel() {
      return state.routedModel ? { model: state.routedModel } : undefined;
    },
    getContextUsage,
    getSessionStats,
  });
  return { state, manager, session, getContextUsage, getSessionStats };
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

  it("avoids 750 unchanged finished-row redraws while preserving retention expiry and status", () => {
    const finished = makeFinishedAgent("finished");
    finished.lifecycle.completedAt = Date.now();
    const host = setup([finished]);
    const initial = [...host.lines];
    host.widget.ensureTimer();
    vi.advanceTimersByTime(60_000);
    expect(host.requestRender).not.toHaveBeenCalled();
    expect(host.lines).toEqual(initial);
    vi.advanceTimersByTime(80);
    expect(host.ui.setWidget).toHaveBeenLastCalledWith("agents", undefined);
    expect(host.lines).toEqual([]);
    expect(host.ui.setStatus).not.toHaveBeenCalledWith("subagents", undefined);
  });

  it("does not redraw an unchanged queue but observes an in-place queued-to-running transition", () => {
    const queued = makeQueuedAgent("queued");
    const host = setup([queued]);
    host.widget.ensureTimer();
    vi.advanceTimersByTime(8_000);
    expect(host.requestRender).not.toHaveBeenCalled();
    queued.lifecycle.status = "running";
    queued.lifecycle.started = true;
    vi.advanceTimersByTime(80);
    expect(host.requestRender).toHaveBeenCalledTimes(1);
    const previous = [...host.lines];
    vi.advanceTimersByTime(80);
    expect(host.requestRender).toHaveBeenCalledTimes(2);
    expect(host.lines).not.toEqual(previous);
  });

  it("keeps visible spinner and activity updates on the 80 ms cadence", () => {
    const running = makeRunningAgent("running");
    const activity: LiveView = { activeTools: new Map(), responseText: "first response" };
    const host = setup([running], () => activity);
    const previous = [...host.lines];
    host.widget.ensureTimer();
    vi.advanceTimersByTime(800);
    expect(host.requestRender).toHaveBeenCalledTimes(10);
    // Ten frames wrap the spinner, while live activity is read afresh on each render.
    expect(host.lines).toEqual(previous);
    activity.responseText = "new response";
    vi.advanceTimersByTime(80);
    expect(host.lines.join("\n")).toContain("new response");
  });

  it("observes finished-record mutations and widget settings without replacing the record", () => {
    const finished = makeFinishedAgent("finished");
    const host = setup([finished]);
    host.widget.ensureTimer();
    finished.stats.contextPercent = 77;
    vi.advanceTimersByTime(80);
    expect(host.requestRender).toHaveBeenCalledTimes(1);
    expect(host.lines.join("\n")).toContain("77%");
    host.widget.setStatsVisibility({ showContext: false });
    vi.advanceTimersByTime(80);
    expect(host.requestRender).toHaveBeenCalledTimes(2);
    expect(host.lines.join("\n")).not.toContain("77%");
    vi.advanceTimersByTime(800);
    expect(host.requestRender).toHaveBeenCalledTimes(2);
  });

  it("honors width changes and theme invalidation after static frames", () => {
    const host = setup([makeFinishedAgent("finished")]);
    host.widget.ensureTimer();
    host.tui.terminal.columns = 30;
    vi.advanceTimersByTime(80);
    expect(host.requestRender).toHaveBeenCalledTimes(1);
    const previous = [...host.lines];
    host.theme.fg = (_color, text) => text;
    host.component?.invalidate();
    vi.advanceTimersByTime(80);
    expect(host.ui.setWidget).toHaveBeenCalledTimes(2);
    expect(host.lines).not.toEqual(previous);
  });

  it("recovers a static widget after a failed host render returned no rows", () => {
    const host = setup([makeFinishedAgent("finished")]);
    const fg = host.theme.fg;
    host.theme.fg = () => {
      throw new Error("transient formatting error");
    };
    host.requestRender();
    expect(host.lines).toEqual([]);
    host.theme.fg = fg;
    host.requestRender.mockClear();
    host.widget.update();
    expect(host.requestRender).toHaveBeenCalledTimes(1);
    expect(host.lines.join("\n")).toContain("Finished agent finished");
  });

  it("does not retain the mutable line array returned to the TUI", () => {
    const host = setup([makeFinishedAgent("finished")]);
    host.lines[1] = "consumer changed its array";
    host.widget.ensureTimer();
    vi.advanceTimersByTime(800);
    expect(host.requestRender).not.toHaveBeenCalled();
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
    host.requestRender.mockClear();
    vi.advanceTimersByTime(1_920);
    expect(host.requestRender).not.toHaveBeenCalled();
    vi.advanceTimersByTime(80);
    expect(host.requestRender).toHaveBeenCalledTimes(1);
    expect(host.lines[1]).toMatch(/^→ /);
    expect(host.lines[2]).toContain("Finished agent finished");
  });

  it("does not suppress fresh component renders triggered by the host", () => {
    const finished = makeFinishedAgent("finished");
    const host = setup([finished]);
    finished.display.description = "updated outside the widget timer";
    expect(host.component?.render().join("\n")).toContain("updated outside the widget timer");
  });

  it("never queries context when context output is disabled", () => {
    const running = makeRunningAgent("running");
    const getContextUsage = vi.fn(() => ({ percent: 50 }));
    const getSessionStats = vi.fn(() => ({ contextUsage: { percent: 50 } }));
    running.execution.session = asAgentSession({ getContextUsage, getSessionStats });
    const host = setup([running]);
    getContextUsage.mockClear();
    getSessionStats.mockClear();
    host.widget.setStatsVisibility({ showContext: false });
    host.widget.ensureTimer();
    vi.advanceTimersByTime(800);
    expect(getContextUsage).not.toHaveBeenCalled();
    expect(getSessionStats).not.toHaveBeenCalled();
  });

  it("reuses context samples across spinner and duplicate component frames with a bounded age", () => {
    const source = contextSession();
    const running = makeRunningAgent("running");
    running.execution.session = source.session;
    const host = setup([running]);
    host.widget.ensureTimer();
    for (let i = 0; i < 100; i++) host.component?.render();
    source.state.percent = 90; // Deliberately unversioned mutation: refreshed within the sample-age bound.
    vi.advanceTimersByTime(480);
    expect(source.getContextUsage).toHaveBeenCalledTimes(1);
    expect(host.lines.join("\n")).toContain("40%");
    vi.advanceTimersByTime(80);
    expect(source.getContextUsage).toHaveBeenCalledTimes(2);
    expect(host.lines.join("\n")).toContain("90%");
    expect(source.getSessionStats).not.toHaveBeenCalled();
  });

  it("refreshes immediately on branch, leaf-entry replacement, and session-ID changes", () => {
    const source = contextSession();
    const running = makeRunningAgent("running");
    running.execution.session = source.session;
    const host = setup([running]);
    source.state.leaf.id = "new-leaf";
    source.state.percent = 50;
    host.widget.update();
    expect(host.lines.join("\n")).toContain("50%");
    source.state.leaf = { id: "new-leaf" }; // A reload can preserve the ID but replace the entry.
    source.state.percent = 60;
    host.widget.update();
    expect(host.lines.join("\n")).toContain("60%");
    source.state.sessionId = "new-session";
    source.state.percent = 70;
    host.widget.update();
    expect(host.lines.join("\n")).toContain("70%");
    expect(source.getContextUsage).toHaveBeenCalledTimes(4);
  });

  it("refreshes on selected and routed model changes without keying the allocated routed wrapper", () => {
    const source = contextSession();
    const running = makeRunningAgent("running");
    running.execution.session = source.session;
    const host = setup([running]);
    source.state.model.contextWindow = 2000;
    host.widget.update();
    expect(source.getContextUsage).toHaveBeenCalledTimes(2);
    source.state.model = { id: "selected-new", contextWindow: 2000 };
    host.widget.update();
    expect(source.getContextUsage).toHaveBeenCalledTimes(3);
    source.state.routedModel = { id: "physical", contextWindow: 4000 };
    host.widget.update();
    host.widget.update();
    expect(source.getContextUsage).toHaveBeenCalledTimes(4);
    source.state.routedModel.contextWindow = 8000;
    host.widget.update();
    expect(source.getContextUsage).toHaveBeenCalledTimes(5);
  });

  it("refreshes compaction state immediately, including unknown post-compaction usage", () => {
    const source = contextSession();
    const running = makeRunningAgent("running");
    running.execution.session = source.session;
    const host = setup([running]);
    source.state.percent = null;
    running.stats.compactionCount++;
    host.widget.update();
    expect(source.getContextUsage).toHaveBeenCalledTimes(2);
    expect(host.lines.join("\n")).not.toContain("40%");
    host.widget.update();
    expect(source.getContextUsage).toHaveBeenCalledTimes(2);
    source.state.leaf = { id: "post-compaction-response" };
    source.state.percent = 12;
    host.widget.update();
    expect(host.lines.join("\n")).toContain("12%");
    expect(source.getContextUsage).toHaveBeenCalledTimes(3);
  });

  it("refreshes after session/getter replacement and when re-enabling context display", () => {
    const source = contextSession();
    const running = makeRunningAgent("running");
    running.execution.session = source.session;
    const host = setup([running]);
    source.session.getContextUsage = vi.fn(() => ({ tokens: 800, contextWindow: 1000, percent: 80 }));
    host.widget.update();
    expect(host.lines.join("\n")).toContain("80%");
    const replacement = contextSession();
    replacement.state.percent = 25;
    running.execution.session = replacement.session;
    host.widget.update();
    expect(host.lines.join("\n")).toContain("25%");
    host.widget.setStatsVisibility({ showContext: false });
    host.widget.update();
    replacement.state.percent = 35;
    host.widget.setStatsVisibility({ showContext: true });
    host.widget.update();
    expect(host.lines.join("\n")).toContain("35%");
    expect(replacement.getContextUsage).toHaveBeenCalledTimes(2);
  });

  it("does not cache legacy sessions lacking branch stamps or let stamp failures hide the widget", () => {
    const running = makeRunningAgent("running");
    let percent = 10;
    const getSessionStats = vi.fn(() => ({ contextUsage: { percent } }));
    running.execution.session = asAgentSession({ getSessionStats });
    const host = setup([running]);
    percent = 20;
    host.widget.update();
    expect(host.lines.join("\n")).toContain("20%");
    expect(getSessionStats).toHaveBeenCalledTimes(2);
    const source = contextSession();
    source.manager.getLeafId = () => {
      throw new Error("stamp unavailable");
    };
    running.execution.session = source.session;
    host.widget.update();
    expect(host.lines.join("\n")).toContain("40%");
  });

  it("clears samples on disposal and resamples after a backwards clock change", () => {
    const source = contextSession();
    const running = makeRunningAgent("running");
    running.execution.session = source.session;
    const host = setup([running]);
    source.state.percent = 30;
    vi.setSystemTime(Date.now() - 1000);
    host.widget.update();
    expect(host.lines.join("\n")).toContain("30%");
    source.state.percent = 20;
    host.widget.dispose();
    host.widget.update();
    expect(host.lines.join("\n")).toContain("20%");
    expect(source.getContextUsage).toHaveBeenCalledTimes(3);
  });

  it("does not format or query hidden running blocks and animates them once navigation reveals them", () => {
    const running = makeRunningAgent("running");
    const getContextUsage = vi.fn(() => ({ percent: 50 }));
    running.execution.session = asAgentSession({ getContextUsage });
    const getLiveView = vi.fn<(id: string) => LiveView | undefined>(() => undefined);
    const host = setup([makeFinishedAgent("one"), makeFinishedAgent("two"), running], getLiveView);
    host.widget.setMaxLines(4);
    host.widget.update();
    getContextUsage.mockClear();
    getLiveView.mockClear();
    host.requestRender.mockClear();
    host.widget.ensureTimer();
    vi.advanceTimersByTime(800);
    expect(host.requestRender).not.toHaveBeenCalled();
    expect(getContextUsage).not.toHaveBeenCalled();
    expect(getLiveView).not.toHaveBeenCalled();
    host.widget.navActivate();
    host.widget.navDown();
    host.widget.navDown();
    expect(host.lines.join("\n")).toContain("Test agent running");
    expect(getContextUsage).toHaveBeenCalled();
    expect(getLiveView).toHaveBeenCalled();
    host.requestRender.mockClear();
    vi.advanceTimersByTime(160);
    expect(host.requestRender).toHaveBeenCalledTimes(2);
  });
});
