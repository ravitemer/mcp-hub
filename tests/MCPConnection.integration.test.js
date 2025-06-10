import { describe, it, expect, vi, beforeEach } from "vitest";
import { MCPConnection } from "../src/MCPConnection.js";

// Mock all external dependencies
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn()
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(),
  getDefaultEnvironment: vi.fn(() => ({ NODE_ENV: 'test' }))
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn()
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn()
}));

vi.mock("../src/utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../src/utils/dev-watcher.js", () => ({
  DevWatcher: vi.fn(() => ({
    on: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }))
}));

// Mock envResolver with controllable behavior
let mockEnvResolver;
vi.mock("../src/utils/env-resolver.js", () => ({
  envResolver: {
    resolveConfig: vi.fn()
  }
}));

describe("MCPConnection Integration Tests", () => {
  let connection;
  let mockClient;
  let mockTransport;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Get the mocked envResolver
    const { envResolver } = await import("../src/utils/env-resolver.js");
    mockEnvResolver = envResolver;

    // Setup default envResolver behavior (pass-through)
    mockEnvResolver.resolveConfig.mockImplementation(async (config, fields) => {
      const resolved = { ...config };
      fields.forEach(field => {
        if (config[field]) {
          resolved[field] = config[field];
        }
      });
      return resolved;
    });

    // Setup mock client
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      request: vi.fn(),
      setNotificationHandler: vi.fn(),
      onerror: null,
      onclose: null,
    };
    Client.mockReturnValue(mockClient);

    // Setup mock transport
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    mockTransport = {
      close: vi.fn().mockResolvedValue(undefined),
      stderr: {
        on: vi.fn()
      }
    };
    StdioClientTransport.mockReturnValue(mockTransport);
  });

  describe("Basic Connection Lifecycle", () => {
    it("should initialize in disconnected state", () => {
      const config = {
        command: "test-server",
        args: ["--port", "3000"],
        type: "stdio"
      };

      connection = new MCPConnection("test-server", config);

      expect(connection.status).toBe("disconnected");
      expect(connection.name).toBe("test-server");
      expect(connection.transportType).toBe("stdio");
      expect(connection.tools).toEqual([]);
      expect(connection.resources).toEqual([]);
      expect(connection.prompts).toEqual([]);
    });

    it("should handle disabled servers", () => {
      const config = {
        command: "test-server",
        args: [],
        type: "stdio",
        disabled: true
      };

      connection = new MCPConnection("test-server", config);

      expect(connection.status).toBe("disabled");
      expect(connection.disabled).toBe(true);
    });
  });

  describe("Environment Resolution Integration", () => {
    it("should resolve stdio server config with envResolver", async () => {
      const config = {
        command: "${MCP_BINARY_PATH}/server",
        args: ["--token", "${API_TOKEN}", "--legacy", "$LEGACY_VAR"],
        env: {
          API_TOKEN: "${cmd: echo secret123}",
          DB_URL: "postgres://user:${DB_PASSWORD}@localhost/db",
          DB_PASSWORD: "password123"
        },
        type: "stdio"
      };

      // Mock envResolver to simulate resolution
      mockEnvResolver.resolveConfig.mockResolvedValueOnce({
        command: "/usr/local/bin/server",
        args: ["--token", "secret123", "--legacy", "legacy_value"],
        env: {
          API_TOKEN: "secret123",
          DB_URL: "postgres://user:password123@localhost/db",
          DB_PASSWORD: "password123"
        }
      });

      connection = new MCPConnection("test-server", config);

      // Mock successful capabilities
      mockClient.request.mockResolvedValue({ tools: [], resources: [], resourceTemplates: [], prompts: [] });

      await connection.connect();

      // Verify envResolver was called with correct parameters
      expect(mockEnvResolver.resolveConfig).toHaveBeenCalledWith(
        config,
        ['env', 'args', 'command']
      );

      // Verify transport was created with resolved config
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      expect(StdioClientTransport).toHaveBeenCalledWith({
        command: "/usr/local/bin/server",
        args: ["--token", "secret123", "--legacy", "legacy_value"],
        env: expect.objectContaining({
          API_TOKEN: "secret123",
          DB_URL: "postgres://user:password123@localhost/db",
          DB_PASSWORD: "password123"
        }),
        stderr: 'pipe'
      });

      expect(connection.status).toBe("connected");
    });

    it("should resolve remote server config with envResolver (HTTP transport)", async () => {
      const config = {
        url: "https://${PRIVATE_DOMAIN}/mcp",
        headers: {
          "Authorization": "Bearer ${cmd: op read secret}",
          "X-Custom": "${CUSTOM_VAR}"
        },
        type: "sse"
      };

      // Mock envResolver to simulate resolution (called twice - once for each transport attempt)
      mockEnvResolver.resolveConfig
        .mockResolvedValueOnce({
          url: "https://private.example.com/mcp",
          headers: {
            "Authorization": "Bearer secret_token_123",
            "X-Custom": "custom_value"
          }
        });

      connection = new MCPConnection("test-server", config);

      // Mock successful capabilities
      mockClient.request.mockResolvedValue({ tools: [], resources: [], resourceTemplates: [], prompts: [] });

      // Mock HTTP transport (should be tried first)
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const mockHTTPTransport = { close: vi.fn() };
      StreamableHTTPClientTransport.mockReturnValue(mockHTTPTransport);

      await connection.connect();

      // Verify envResolver was called for URL and headers
      expect(mockEnvResolver.resolveConfig).toHaveBeenCalledWith(
        config,
        ['url', 'headers']
      );

      // Verify HTTP transport was created with resolved URL (tries HTTP first)
      expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
        new URL("https://private.example.com/mcp"),
        expect.objectContaining({
          requestInit: {
            headers: {
              "Authorization": "Bearer secret_token_123",
              "X-Custom": "custom_value"
            }
          }
        })
      );

      expect(connection.status).toBe("connected");
    });

    it("should fallback to SSE transport when HTTP fails", async () => {
      const config = {
        url: "https://${PRIVATE_DOMAIN}/mcp",
        headers: {
          "Authorization": "Bearer ${cmd: op read secret}",
          "X-Custom": "${CUSTOM_VAR}"
        },
        type: "sse"
      };

      // Mock envResolver to simulate resolution (called twice - once for each transport attempt)
      mockEnvResolver.resolveConfig
        .mockResolvedValueOnce({
          url: "https://private.example.com/mcp",
          headers: {
            "Authorization": "Bearer secret_token_123",
            "X-Custom": "custom_value"
          }
        })
        .mockResolvedValueOnce({
          url: "https://private.example.com/mcp",
          headers: {
            "Authorization": "Bearer secret_token_123",
            "X-Custom": "custom_value"
          }
        });

      connection = new MCPConnection("test-server", config);

      // Mock HTTP transport to fail (non-auth error)
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      StreamableHTTPClientTransport.mockImplementation(() => {
        throw new Error("HTTP transport failed");
      });

      // Mock SSE transport to succeed
      const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
      const mockSSETransport = { close: vi.fn() };
      SSEClientTransport.mockReturnValue(mockSSETransport);

      // Mock successful capabilities
      mockClient.request.mockResolvedValue({ tools: [], resources: [], resourceTemplates: [], prompts: [] });

      await connection.connect();

      // Verify envResolver was called twice (once for HTTP, once for SSE)
      expect(mockEnvResolver.resolveConfig).toHaveBeenCalledTimes(2);

      // Verify SSE transport was created after HTTP failed
      expect(SSEClientTransport).toHaveBeenCalledWith(
        new URL("https://private.example.com/mcp"),
        expect.objectContaining({
          requestInit: {
            headers: {
              "Authorization": "Bearer secret_token_123",
              "X-Custom": "custom_value"
            }
          }
        })
      );

      expect(connection.status).toBe("connected");
    });
  });

  describe("Error Handling", () => {
    it("should handle envResolver errors gracefully", async () => {
      const config = {
        command: "${INVALID_COMMAND}",
        args: [],
        env: {},
        type: "stdio"
      };

      // Mock envResolver to throw an error
      const resolverError = new Error("Command execution failed");
      mockEnvResolver.resolveConfig.mockRejectedValueOnce(resolverError);

      connection = new MCPConnection("test-server", config);

      await expect(connection.connect()).rejects.toThrow(
        'Failed to connect to "test-server" MCP server: Command execution failed'
      );

      expect(connection.status).toBe("disconnected");
    });

    it("should handle transport creation errors", async () => {
      const config = {
        command: "test-server",
        args: [],
        env: {},
        type: "stdio"
      };

      // Mock successful resolution but transport creation failure
      mockEnvResolver.resolveConfig.mockResolvedValueOnce(config);

      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      StdioClientTransport.mockImplementation(() => {
        throw new Error("Transport creation failed");
      });

      connection = new MCPConnection("test-server", config);

      await expect(connection.connect()).rejects.toThrow(
        'Failed to connect to "test-server" MCP server: Transport creation failed'
      );
    });
  });
});
