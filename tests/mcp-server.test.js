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

  it("runs cleanup at most once when both res.close and transport.onclose fire", async () => {
    // Reproduces a recursive teardown bug: server.close() inside cleanup
    // calls transport.close() -> res.end() which re-fires the "close" event,
    // re-entering cleanup -> server.close() and recursing until V8 throws
    // RangeError: Maximum call stack size exceeded. Some clients (notably
    // Cursor's MCP integration) reliably trigger this on every reconnect.
    const endpoint = new MCPServerEndpoint(makeMcpHubStub());

    const req = {};
    const res = new EventEmitter();
    res.write = () => {};
    res.end = () => {};

    await endpoint.handleSSEConnection(req, res);

    const session = [...endpoint.clients.values()][0];
    expect(session, "session should be registered before cleanup").toBeDefined();
    const { transport, server } = session;

    // Simulate the recursion: both teardown paths fire, as happens in
    // production when server.close() ends the response stream.
    res.emit("close");
    await transport.onclose();

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(endpoint.clients.has("test-session")).toBe(false);
  });
});
