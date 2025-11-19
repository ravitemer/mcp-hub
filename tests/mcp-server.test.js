import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MCPServerEndpoint } from "../src/mcp/server.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Mock MCP SDK
vi.mock("@modelcontextprotocol/sdk/server/index.js");
vi.mock("@modelcontextprotocol/sdk/server/sse.js");
vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js");

// Mock logger
vi.mock("../src/utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock MCPHub
vi.mock("../src/MCPHub.js", () => ({
  MCPHub: vi.fn(() => ({
    on: vi.fn(),
    rawRequest: vi.fn(),
  })),
}));

describe("MCPServerEndpoint", () => {
  let endpoint;
  let mockMCPHub;
  let mockServer;
  let mockTransport;
  let mockReq;
  let mockRes;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Mock MCP Hub
    const { MCPHub } = await import("../src/MCPHub.js");
    mockMCPHub = {
      on: vi.fn(),
      rawRequest: vi.fn(),
      getAllServerStatuses: vi.fn().mockReturnValue({}),
      connections: new Map(), // Add connections map for syncCapabilities
    };
    MCPHub.mockReturnValue(mockMCPHub);

    // Mock Server
    mockServer = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      setRequestHandler: vi.fn(),
      getClientVersion: vi.fn().mockReturnValue({ name: "test-client" }),
      oninitialized: null,
      onerror: null,
    };
    Server.mockImplementation(() => mockServer);

    // Mock SSE Transport
    mockTransport = {
      sessionId: "test-session-id",
      onclose: null,
      close: vi.fn().mockResolvedValue(undefined),
    };
    SSEServerTransport.mockImplementation(() => mockTransport);

    // Mock Streamable HTTP Transport
    StreamableHTTPServerTransport.mockImplementation(() => ({
      sessionId: "streamable-session-id",
      onclose: null,
      close: vi.fn().mockResolvedValue(undefined),
      handleRequest: vi.fn().mockResolvedValue(undefined),
    }));

    // Create endpoint instance
    endpoint = new MCPServerEndpoint(mockMCPHub);

    // Mock request and response
    mockReq = {
      url: "/mcp",
      headers: {},
      on: vi.fn(),
    };

    mockRes = {
      on: vi.fn(),
      setHeader: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      writableEnded: false,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("SSE Connection Cleanup", () => {
    it("should prevent infinite recursion with cleanup guard", async () => {
      // Simulate SSE connection
      await endpoint.handleSSEConnection(mockReq, mockRes);

      // Get the cleanup function by triggering the onclose handler
      const cleanupFn = mockTransport.onclose;
      expect(cleanupFn).toBeDefined();

      // Call cleanup multiple times - should only execute once due to guard
      await cleanupFn();
      await cleanupFn();
      await cleanupFn();

      // Server.close should only be called once, not three times
      expect(mockServer.close).toHaveBeenCalledTimes(1);
    });

    it("should handle cleanup when response closes", async () => {
      await endpoint.handleSSEConnection(mockReq, mockRes);

      // Get the response close handler
      const resCloseHandler = mockRes.on.mock.calls.find(
        (call) => call[0] === "close"
      )?.[1];
      expect(resCloseHandler).toBeDefined();

      // Trigger response close
      await resCloseHandler();

      // Should call server.close
      expect(mockServer.close).toHaveBeenCalled();
    });

    it("should not throw when cleanup is called during server.close", async () => {
      // Mock server.close to trigger transport.close which triggers cleanup
      mockServer.close.mockImplementation(async () => {
        if (mockTransport.onclose) {
          await mockTransport.onclose();
        }
      });

      await endpoint.handleSSEConnection(mockReq, mockRes);

      // This should not cause infinite recursion or throw
      const cleanupFn = mockTransport.onclose;
      await expect(cleanupFn()).resolves.not.toThrow();

      // Should still only call server.close once
      expect(mockServer.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("Streamable HTTP Cleanup", () => {
    let streamableTransport;

    beforeEach(() => {
      streamableTransport = {
        sessionId: null,
        onclose: null,
        close: vi.fn().mockResolvedValue(undefined),
        handleRequest: vi.fn().mockImplementation(async (req, res, body) => {
          // Simulate session ID being set during handleRequest
          if (!streamableTransport.sessionId) {
            streamableTransport.sessionId = "streamable-session-id";
          }
        }),
      };
      StreamableHTTPServerTransport.mockImplementation(
        () => streamableTransport
      );
    });

    it("should prevent infinite recursion in streamable HTTP cleanup", async () => {
      await endpoint.handleStreamableHTTP(mockReq, mockRes);

      // Get the cleanup function
      const cleanupFn = streamableTransport.onclose;
      expect(cleanupFn).toBeDefined();

      // Call cleanup multiple times
      await cleanupFn();
      await cleanupFn();
      await cleanupFn();

      // Server.close should only be called once
      expect(mockServer.close).toHaveBeenCalledTimes(1);
    });

    it("should handle cleanup when transport closes during server.close", async () => {
      // Mock server.close to trigger transport.close
      mockServer.close.mockImplementation(async () => {
        if (streamableTransport.onclose) {
          await streamableTransport.onclose();
        }
      });

      await endpoint.handleStreamableHTTP(mockReq, mockRes);

      const cleanupFn = streamableTransport.onclose;
      await expect(cleanupFn()).resolves.not.toThrow();
      expect(mockServer.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("Session Management", () => {
    it("should clean up session from clients map on SSE disconnect", async () => {
      await endpoint.handleSSEConnection(mockReq, mockRes);

      // Verify session was added
      expect(endpoint.clients.has("test-session-id")).toBe(true);

      // Trigger cleanup
      const cleanupFn = mockTransport.onclose;
      await cleanupFn();

      // Verify session was removed
      expect(endpoint.clients.has("test-session-id")).toBe(false);
    });

    it("should clean up session from clients map on Streamable HTTP disconnect", async () => {
      const streamableTransport = {
        sessionId: "streamable-session-id",
        onclose: null,
        close: vi.fn().mockResolvedValue(undefined),
        handleRequest: vi.fn().mockResolvedValue(undefined),
      };
      StreamableHTTPServerTransport.mockImplementation(
        () => streamableTransport
      );

      await endpoint.handleStreamableHTTP(mockReq, mockRes);

      // Manually add to clients map (normally done by handleRequest wrapper)
      endpoint.clients.set("streamable-session-id", {
        transport: streamableTransport,
        server: mockServer,
      });

      // Trigger cleanup
      const cleanupFn = streamableTransport.onclose;
      await cleanupFn();

      // Verify session was removed
      expect(endpoint.clients.has("streamable-session-id")).toBe(false);
    });
  });
});
