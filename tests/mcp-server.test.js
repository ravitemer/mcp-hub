import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: vi.fn().mockImplementation(() => ({
    setRequestHandler: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    onerror: null,
    oninitialized: null,
    getClientVersion: () => null,
  })),
}));

vi.mock("@modelcontextprotocol/sdk/server/sse.js", () => ({
  SSEServerTransport: vi.fn().mockImplementation(() => ({
    sessionId: "test-session",
    onclose: null,
    handlePostMessage: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../src/utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../src/utils/sse-manager.js", () => ({
  HubState: {
    STARTING: "starting",
    READY: "ready",
    RESTARTED: "restarted",
    STOPPED: "stopped",
    ERROR: "error",
  },
}));

import { MCPServerEndpoint } from "../src/mcp/server.js";

const makeMcpHubStub = () => {
  const stub = new EventEmitter();
  stub.connections = new Map();
  stub.hubServerUrl = "http://localhost:0";
  stub.getAllServerStatuses = () => [];
  return stub;
};

describe("MCPServerEndpoint.handleSSEConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Regression for the recursive SSE teardown documented in
  // src/mcp/server.js#handleSSEConnection.
  it("runs cleanup at most once when both teardown paths fire in sequence", async () => {
    const endpoint = new MCPServerEndpoint(makeMcpHubStub());

    const req = {};
    const res = new EventEmitter();
    res.write = () => {};
    res.end = () => {};

    await endpoint.handleSSEConnection(req, res);

    const session = [...endpoint.clients.values()][0];
    expect(session, "session should be registered before cleanup").toBeDefined();
    const { transport, server } = session;

    res.emit("close");
    await transport.onclose();

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(endpoint.clients.has("test-session")).toBe(false);
  });

  // Reconstructs the production recursion: server.close → transport.close →
  // res.end → re-emits "close" → re-enters cleanup. Without the guard this
  // recurses synchronously until V8 throws RangeError; with the guard,
  // server.close is called exactly once.
  it("does not recurse when server.close re-fires the response close event", async () => {
    const endpoint = new MCPServerEndpoint(makeMcpHubStub());

    const req = {};
    const res = new EventEmitter();
    res.write = () => {};
    res.end = () => res.emit("close");

    await endpoint.handleSSEConnection(req, res);

    const session = [...endpoint.clients.values()][0];
    const { transport, server } = session;
    server.close.mockImplementation(async () => transport.close());
    transport.close.mockImplementation(async () => res.end());

    await transport.onclose();

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(endpoint.clients.has("test-session")).toBe(false);
  });
});
