import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// Mock dependencies
vi.mock("../src/utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    setSseManager: vi.fn(),
  },
}));

vi.mock("../src/MCPHub.js", () => ({
  MCPHub: vi.fn(() => ({
    on: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    getAllServerStatuses: vi.fn().mockReturnValue({}),
  })),
}));

vi.mock("../src/mcp/server.js", () => ({
  MCPServerEndpoint: vi.fn(),
}));

vi.mock("../src/marketplace.js", () => ({
  getMarketplace: vi.fn(() => ({
    initialize: vi.fn(),
  })),
}));

vi.mock("../src/utils/workspace-cache.js", () => ({
  WorkspaceCacheManager: vi.fn(() => ({
    register: vi.fn(),
    updateActiveConnections: vi.fn(),
  })),
}));

describe("Server Routing - GET /mcp", () => {
  let app;
  let mockMCPServerEndpoint;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create express app
    app = express();
    app.use(express.json());

    // Mock MCP server endpoint
    mockMCPServerEndpoint = {
      handleSSEConnection: vi.fn().mockImplementation(async (req, res) => {
        res.setHeader("Content-Type", "text/event-stream");
        res.write("data: SSE connection established\n\n");
        res.end();
      }),
      handleStreamableHTTP: vi.fn().mockImplementation(async (req, res) => {
        res.status(200).json({ status: "Streamable HTTP" });
      }),
    };

    // Setup GET /mcp route with the routing logic from server.js
    app.get("/mcp", async (req, res) => {
      try {
        const sessionId = req.headers["mcp-session-id"];
        const acceptsSSE = req.headers.accept?.includes("text/event-stream");

        if (sessionId) {
          // Streamable HTTP GET request (for server-to-client messages in active session)
          await mockMCPServerEndpoint.handleStreamableHTTP(req, res);
        } else {
          // Legacy SSE transport (backward compatibility)
          // Any GET request without a session ID is assumed to be an SSE connection attempt
          await mockMCPServerEndpoint.handleSSEConnection(req, res);
        }
      } catch (error) {
        if (!res.headersSent) {
          res.status(500).send("Error establishing MCP connection");
        }
      }
    });
  });

  describe("SSE Routing", () => {
    it("should route to SSE handler when Accept header is text/event-stream", async () => {
      const response = await request(app)
        .get("/mcp")
        .set("Accept", "text/event-stream")
        .expect(200);

      expect(mockMCPServerEndpoint.handleSSEConnection).toHaveBeenCalled();
      expect(mockMCPServerEndpoint.handleStreamableHTTP).not.toHaveBeenCalled();
      expect(response.headers["content-type"]).toContain("text/event-stream");
    });

    it("should route to SSE handler when Accept header is */* (wildcard)", async () => {
      await request(app).get("/mcp").set("Accept", "*/*").expect(200);

      expect(mockMCPServerEndpoint.handleSSEConnection).toHaveBeenCalled();
      expect(mockMCPServerEndpoint.handleStreamableHTTP).not.toHaveBeenCalled();
    });

    it("should route to SSE handler when no Accept header is provided", async () => {
      await request(app).get("/mcp").expect(200);

      expect(mockMCPServerEndpoint.handleSSEConnection).toHaveBeenCalled();
      expect(mockMCPServerEndpoint.handleStreamableHTTP).not.toHaveBeenCalled();
    });

    it("should route to SSE handler for non-standard Accept headers", async () => {
      await request(app)
        .get("/mcp")
        .set("Accept", "application/json")
        .expect(200);

      expect(mockMCPServerEndpoint.handleSSEConnection).toHaveBeenCalled();
      expect(mockMCPServerEndpoint.handleStreamableHTTP).not.toHaveBeenCalled();
    });

    it("should route to SSE handler when no session ID is present", async () => {
      await request(app)
        .get("/mcp")
        .set("Accept", "text/html")
        .expect(200);

      expect(mockMCPServerEndpoint.handleSSEConnection).toHaveBeenCalled();
      expect(mockMCPServerEndpoint.handleStreamableHTTP).not.toHaveBeenCalled();
    });
  });

  describe("Streamable HTTP Routing", () => {
    it("should route to Streamable HTTP handler when session ID is present", async () => {
      const response = await request(app)
        .get("/mcp")
        .set("mcp-session-id", "test-session-123")
        .set("Accept", "*/*")
        .expect(200);

      expect(mockMCPServerEndpoint.handleStreamableHTTP).toHaveBeenCalled();
      expect(mockMCPServerEndpoint.handleSSEConnection).not.toHaveBeenCalled();
      expect(response.body).toEqual({ status: "Streamable HTTP" });
    });

    it("should route to Streamable HTTP even with text/event-stream if session ID present", async () => {
      await request(app)
        .get("/mcp")
        .set("mcp-session-id", "test-session-456")
        .set("Accept", "text/event-stream")
        .expect(200);

      expect(mockMCPServerEndpoint.handleStreamableHTTP).toHaveBeenCalled();
      expect(mockMCPServerEndpoint.handleSSEConnection).not.toHaveBeenCalled();
    });
  });

  describe("Backward Compatibility", () => {
    it("should support legacy clients like Kilo Code with Accept: */*", async () => {
      // Kilo Code sends Accept: */* without session ID
      const response = await request(app)
        .get("/mcp")
        .set("Accept", "*/*")
        .set("User-Agent", "node")
        .expect(200);

      // Should route to SSE, not return 406
      expect(mockMCPServerEndpoint.handleSSEConnection).toHaveBeenCalled();
      expect(response.status).not.toBe(406);
    });

    it("should not return 406 for clients without proper Accept headers", async () => {
      const response = await request(app)
        .get("/mcp")
        .set("User-Agent", "test-client")
        .expect(200);

      expect(response.status).not.toBe(406);
      expect(mockMCPServerEndpoint.handleSSEConnection).toHaveBeenCalled();
    });
  });

  describe("Request Validation", () => {
    it("should handle requests with multiple Accept values", async () => {
      await request(app)
        .get("/mcp")
        .set("Accept", "application/json, text/event-stream, */*")
        .expect(200);

      // Should still route to SSE since no session ID
      expect(mockMCPServerEndpoint.handleSSEConnection).toHaveBeenCalled();
    });

    it("should prioritize session ID over Accept header", async () => {
      await request(app)
        .get("/mcp")
        .set("mcp-session-id", "priority-test")
        .set("Accept", "*/*")
        .expect(200);

      // Should route to Streamable HTTP because session ID is present
      expect(mockMCPServerEndpoint.handleStreamableHTTP).toHaveBeenCalled();
      expect(mockMCPServerEndpoint.handleSSEConnection).not.toHaveBeenCalled();
    });
  });

  describe("Error Handling", () => {
    it("should handle SSE connection errors gracefully", async () => {
      mockMCPServerEndpoint.handleSSEConnection.mockRejectedValueOnce(
        new Error("SSE connection failed")
      );

      await request(app).get("/mcp").expect(500);
    });

    it("should handle Streamable HTTP errors gracefully", async () => {
      mockMCPServerEndpoint.handleStreamableHTTP.mockRejectedValueOnce(
        new Error("Streamable HTTP failed")
      );

      await request(app)
        .get("/mcp")
        .set("mcp-session-id", "error-test")
        .expect(500);
    });
  });
});
