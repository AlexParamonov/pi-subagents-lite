/**
 * manager-mocks.ts — Shared mock setup for AgentManager tests.
 *
 * This file MUST be imported as the FIRST import in each AgentManager test
 * file: it registers the vi.mock() calls for the manager's dependencies
 * (crypto, fs, agent-runner, output-file, agent-types, shell) before any
 * src module loads. Tests drive the mutable mockModules / mockStoreState
 * objects and the mockAgentSession / mockRunResult factories.
 */
import { vi, type Mock } from "vitest";
import type { AgentSession, AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentRecord } from "../../src/types.js";
let uuidCounter = 0;
const hoisted = vi.hoisted(() => ({
  mockRunAgent: vi.fn(),
  mockContinueAgentSession: vi.fn(),
  mockRandomUUID: vi.fn(() => {
    uuidCounter++;
    return `agent-${String(uuidCounter).padStart(8, "0")}`;
  }),
  resetUuidCounter: () => {
    uuidCounter = 0;
  },
  fsMock: {
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
    existsSync: vi.fn(),
  },
  mockAgentOutputLog: vi.fn(function () {
    return { attach: vi.fn(), finalize: vi.fn(), path: "/tmp/out.log" };
  }),
  mockGetAgentConfig: vi.fn(() => undefined),
}));
export const mockModules = {
  mockRunAgent: hoisted.mockRunAgent,
  mockContinueAgentSession: hoisted.mockContinueAgentSession,
  mockRandomUUID: hoisted.mockRandomUUID,
  resetUuidCounter: hoisted.resetUuidCounter,
  fsMock: hoisted.fsMock,
  mockAgentOutputLog: hoisted.mockAgentOutputLog,
  mockGetAgentConfig: hoisted.mockGetAgentConfig,
};
// Controllable store values; the shell mock below reads them via getters so
// tests can flip a value and have the next store access see it.
export const mockStoreState = {
  toolTimeoutMinutes: 0,
  idleTimeoutMinutes: 0,
  outputThinkingBufferSize: 0,
  outputTranscript: true,
};
// Shared agent object so getStore() returns the same reference each time.
const mockStoreAgent = {
  get toolTimeoutMinutes() {
    return mockStoreState.toolTimeoutMinutes;
  },
  get idleTimeoutMinutes() {
    return mockStoreState.idleTimeoutMinutes;
  },
  get outputThinkingBufferSize() {
    return mockStoreState.outputThinkingBufferSize;
  },
  get outputTranscript() {
    return mockStoreState.outputTranscript;
  },
};
vi.mock("node:crypto", () => ({
  randomUUID: mockModules.mockRandomUUID,
}));
vi.mock("node:fs", () => mockModules.fsMock);
vi.mock("../../src/agents/agent-runner.js", () => ({
  runAgent: mockModules.mockRunAgent,
  continueAgentSession: mockModules.mockContinueAgentSession,
}));
vi.mock("../../src/agents/output-file.js", () => ({
  AgentOutputLog: mockModules.mockAgentOutputLog,
}));
vi.mock("../../src/agents/agent-types.js", () => ({
  getAgentConfig: mockModules.mockGetAgentConfig,
}));
vi.mock("../../src/shell.js", () => ({
  getStore: () => ({ agent: mockStoreAgent }),
  // Real coordinator calls (one persistence test drives the real spawn path).
  getWidget: () => undefined,
  getPiInstance: () => undefined,
  getSessionCtx: () => undefined,
}));
/** Mirrors AgentManager's private OnAgentComplete callback signature. */
export type OnAgentComplete = (record: AgentRecord) => void;
/** The model subset of a fake session — what src reads (provider/id/name). */
export interface FakeSessionModel {
  provider: string;
  id: string;
  name?: string;
}
/** Shape of the fake session objects mockRunResult resolves with. */
export interface MockAgentSession {
  subscribe: Mock<(listener: AgentSessionEventListener) => () => void>;
  messages: AgentSession["messages"];
  dispose: Mock<() => void>;
  isStreaming: boolean;
  steer: Mock<(text: string, images?: ImageContent[]) => Promise<void>>;
  abort: Mock<() => Promise<void>>;
  model?: FakeSessionModel;
}
export interface MockAgentSessionOptions {
  isStreaming?: boolean;
  model?: FakeSessionModel;
}
export function mockAgentSession(options: MockAgentSessionOptions = {}): MockAgentSession {
  return {
    subscribe: vi.fn<(listener: AgentSessionEventListener) => () => void>(),
    messages: [],
    dispose: vi.fn<() => void>(),
    isStreaming: options.isStreaming ?? false,
    steer: vi.fn<(text: string, images?: ImageContent[]) => Promise<void>>(async () => {}),
    abort: vi.fn(async () => {}),
    model: options.model,
  };
}
/** Shape the runAgent/continueAgentSession mocks resolve with. */
export interface MockRunResult {
  responseText: string;
  session: MockAgentSession;
  aborted: boolean;
  turnLimited: boolean;
  modelError?: string;
}
export function mockRunResult(overrides?: Partial<MockRunResult>): MockRunResult {
  return {
    responseText: "done",
    session: mockAgentSession(),
    aborted: false,
    turnLimited: false,
    ...overrides,
  };
}
