import { describe, it, expect, vi, beforeEach } from "vitest";
import { MCPConnection } from "../src/MCPConnection.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ConnectionError,
  ToolError,
  ResourceError,
  wrapError,
} from "../src/utils/errors.js";

// Mock MCP SDK
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(() => ({
    connect: vi.fn(),
    close: vi.fn(),
    request: vi.fn(),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(() => ({
    close: vi.fn(),
    stderr: {
      on: vi.fn(),
    },
    onerror: null,
    onclose: null,
  })),
}));

// Mock logger
vi.mock("../src/utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe("MCPConnection", () => {
  let connection;
  let client;
  let transport;
  let mockConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockConfig = {
      command: "test-server",
      args: ["--port", "3000"],
      env: { TEST_ENV: "value" },
    };

    // Setup client mock
    client = new Client();
    Client.mockReturnValue(client);

    // Setup transport mock
    transport = new StdioClientTransport();
    StdioClientTransport.mockReturnValue(transport);

    // Create connection instance
    connection = new MCPConnection("test-server", mockConfig);
  });

  describe("Connection Lifecycle", () => {
    it("should initialize in disconnected state", () => {
      expect(connection.status).toBe("disconnected");
      expect(connection.error).toBeNull();
      expect(connection.tools).toEqual([]);
      expect(connection.resources).toEqual([]);
      expect(connection.resourceTemplates).toEqual([]);
    });

    it("should connect successfully", async () => {
      // Mock successful capability discovery
      client.request.mockImplementation(async ({ method }) => {
        switch (method) {
          case "tools/list":
            return { tools: [{ name: "test-tool" }] };
          case "resources/list":
            return { resources: [{ uri: "test://resource" }] };
          case "resources/templates/list":
            return { resourceTemplates: [{ uriTemplate: "test://{param}" }] };
        }
      });

      await connection.connect();

      expect(connection.status).toBe("connected");
      expect(connection.error).toBeNull();
      expect(connection.tools).toHaveLength(1);
      expect(connection.resources).toHaveLength(1);
      expect(connection.resourceTemplates).toHaveLength(1);
    });

    it("should handle connection errors", async () => {
      const error = new Error("Connection failed");
      client.connect.mockRejectedValueOnce(error);

      await expect(connection.connect()).rejects.toThrow(
        new ConnectionError("Failed to establish server connection", {
          server: "test-server",
          error: error.message,
        })
      );
      expect(connection.status).toBe("disconnected");
      expect(connection.error).toBe(error.message);
    });

    it("should handle transport errors", async () => {
      await connection.connect();

      const error = new Error("Transport error");
      transport.onerror(error);

      expect(connection.status).toBe("disconnected");
      expect(connection.error).toBe(error.message);
    });

    it("should handle transport close", async () => {
      await connection.connect();
      transport.onclose();

      expect(connection.status).toBe("disconnected");
      expect(connection.startTime).toBeNull();
    });

    it("should handle stderr output", async () => {
      let stderrCallback;
      transport.stderr.on.mockImplementation((event, cb) => {
        if (event === "data") stderrCallback = cb;
      });

      await connection.connect();

      stderrCallback(Buffer.from("Error output"));
      expect(connection.error).toBe("Error output");
    });

    it("should disconnect cleanly", async () => {
      await connection.connect();
      await connection.disconnect();

      expect(client.close).toHaveBeenCalled();
      expect(transport.close).toHaveBeenCalled();
      expect(connection.status).toBe("disconnected");
      expect(connection.client).toBeNull();
      expect(connection.transport).toBeNull();
    });
  });

  describe("Capability Discovery", () => {
    it("should handle partial capabilities", async () => {
      // Only tools supported
      client.request.mockImplementation(async ({ method }) => {
        if (method === "tools/list") {
          return { tools: [{ name: "test-tool" }] };
        }
        throw new Error("Not supported");
      });

      await connection.connect();

      expect(connection.tools).toHaveLength(1);
      expect(connection.resources).toHaveLength(0);
      expect(connection.resourceTemplates).toHaveLength(0);
    });

    it("should handle capability update errors", async () => {
      client.request.mockRejectedValue(new Error("Update failed"));

      await connection.updateCapabilities();

      expect(connection.tools).toEqual([]);
      expect(connection.resources).toEqual([]);
      expect(connection.resourceTemplates).toEqual([]);
    });
  });

  describe("Tool Execution", () => {
    beforeEach(async () => {
      client.request.mockImplementation(async ({ method }) => {
        switch (method) {
          case "tools/list":
            return { tools: [{ name: "test-tool" }] };
          case "tools/call":
            return { output: "success" };
        }
      });

      await connection.connect();
    });

    it("should execute tool successfully", async () => {
      const result = await connection.callTool("test-tool", { param: "value" });

      expect(result).toEqual({ output: "success" });
      expect(client.request).toHaveBeenCalledWith(
        {
          method: "tools/call",
          params: {
            name: "test-tool",
            arguments: { param: "value" },
          },
        },
        expect.any(Object)
      );
    });

    it("should throw error for non-existent tool", async () => {
      await expect(connection.callTool("invalid-tool", {})).rejects.toThrow(
        new ToolError("Tool not found", {
          server: "test-server",
          tool: "invalid-tool",
          availableTools: ["test-tool"],
        })
      );
    });

    it("should throw error when not connected", async () => {
      connection.client = null;

      await expect(connection.callTool("test-tool", {})).rejects.toThrow(
        new ToolError("Server not initialized", {
          server: "test-server",
          tool: "test-tool",
        })
      );
    });

    it("should handle tool execution errors", async () => {
      const error = new Error("Tool failed");
      client.request.mockRejectedValueOnce(error);

      await expect(connection.callTool("test-tool", {})).rejects.toThrow(
        wrapError(error, "TOOL_EXECUTION_ERROR", {
          server: "test-server",
          tool: "test-tool",
          args: {},
        })
      );
    });
  });

  describe("Resource Access", () => {
    beforeEach(async () => {
      client.request.mockImplementation(async ({ method }) => {
        switch (method) {
          case "resources/list":
            return { resources: [{ uri: "test://resource" }] };
          case "resources/templates/list":
            return {
              resourceTemplates: [{ uriTemplate: "template://{param}" }],
            };
          case "resources/read":
            return { content: "resource content" };
        }
      });

      await connection.connect();
    });

    it("should read resource successfully", async () => {
      const result = await connection.readResource("test://resource");

      expect(result).toEqual({ content: "resource content" });
      expect(client.request).toHaveBeenCalledWith(
        {
          method: "resources/read",
          params: { uri: "test://resource" },
        },
        expect.any(Object)
      );
    });

    it("should handle template resources", async () => {
      const result = await connection.readResource("template://value");

      expect(result).toEqual({ content: "resource content" });
    });

    it("should throw error for non-existent resource", async () => {
      await expect(
        connection.readResource("invalid://resource")
      ).rejects.toThrow(
        new ResourceError("Resource not found", {
          server: "test-server",
          uri: "invalid://resource",
          availableResources: ["test://resource"],
          availableTemplates: ["template://{param}"],
        })
      );
    });

    it("should throw error when not connected", async () => {
      connection.client = null;

      await expect(connection.readResource("test://resource")).rejects.toThrow(
        new ResourceError("Server not initialized", {
          server: "test-server",
          uri: "test://resource",
        })
      );
    });

    it("should handle resource read errors", async () => {
      const error = new Error("Read failed");
      client.request.mockRejectedValueOnce(error);

      await expect(connection.readResource("test://resource")).rejects.toThrow(
        wrapError(error, "RESOURCE_READ_ERROR", {
          server: "test-server",
          uri: "test://resource",
        })
      );
    });
  });

  describe("Server Info", () => {
    beforeEach(async () => {
      await connection.connect();
    });

    it("should report server info correctly", () => {
      // Mock successful capability discovery
      client.request.mockImplementation(async ({ method }) => {
        switch (method) {
          case "tools/list":
            return { tools: [{ name: "test-tool" }] };
          case "resources/list":
            return { resources: [{ uri: "test://resource" }] };
          case "resources/templates/list":
            return {
              resourceTemplates: [{ uriTemplate: "template://{param}" }],
            };
        }
      });

      const info = connection.getServerInfo();

      expect(info).toEqual({
        name: "test-server",
        status: "connected",
        error: null,
        capabilities: {
          tools: [],
          resources: [{ uri: "test://resource" }],
          resourceTemplates: [{ uriTemplate: "template://{param}" }],
        },
        uptime: 0,
        lastStarted: expect.any(String),
      });
    });

    it("should calculate uptime", () => {
      vi.advanceTimersByTime(5000);

      const info = connection.getServerInfo();
      expect(info.uptime).toBe(5);
    });

    it("should report zero uptime when disconnected", () => {
      vi.advanceTimersByTime(5000);
      connection.startTime = null;

      const info = connection.getServerInfo();
      expect(info.uptime).toBe(0);
    });
  });
});
