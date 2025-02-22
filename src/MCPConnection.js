import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ListToolsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  CallToolResultSchema,
  ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import logger from "./utils/logger.js";
import {
  ConnectionError,
  ToolError,
  ResourceError,
  wrapError,
} from "./utils/errors.js";

export class MCPConnection {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.client = null;
    this.transport = null;
    this.tools = [];
    this.resources = [];
    this.resourceTemplates = [];
    this.status = "disconnected"; // disconnected | connecting | connected
    this.error = null;
    this.startTime = null;
    this.lastStarted = null;
  }

  // Calculate uptime in seconds
  getUptime() {
    if (!this.startTime || this.status !== "connected") {
      return 0;
    }
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  async connect() {
    try {
      this.status = "connecting";
      this.lastStarted = new Date().toISOString();

      this.client = new Client(
        {
          name: "mcp-hub",
          version: "1.0.0",
        },
        {
          capabilities: {},
        }
      );

      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args || [],
        env: {
          ...(this.config.env || {}),
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        },
        stderr: "pipe",
      });

      // Handle transport errors
      this.transport.onerror = (error) => {
        const connectionError = new ConnectionError(
          "Failed to communicate with server",
          {
            server: this.name,
            error: error.message,
          }
        );
        logger.error(
          connectionError.code,
          connectionError.message,
          connectionError.data,
          false
        );
        this.error = error.message;
        this.status = "disconnected";
        this.startTime = null;
      };

      this.transport.onclose = () => {
        logger.info("Transport connection closed", {
          server: this.name,
        });
        this.status = "disconnected";
        this.startTime = null;
      };

      // Set up stderr handling before connecting
      const stderrStream = this.transport.stderr;
      if (stderrStream) {
        stderrStream.on("data", (data) => {
          const errorOutput = data.toString();
          const error = new ConnectionError("Server error output", {
            server: this.name,
            error: errorOutput,
          });
          logger.error(error.code, error.message, error.data, false);
          this.error = errorOutput;
        });
      }

      // Connect client (this will start the transport)
      await this.client.connect(this.transport);

      // Fetch initial capabilities before marking as connected
      await this.updateCapabilities();

      // Only mark as connected after capabilities are fetched
      this.status = "connected";
      this.startTime = Date.now();
      this.error = null;

      logger.info("MCP client connected", {
        server: this.name,
        tools: this.tools.length,
        resources: this.resources.length,
      });
    } catch (error) {
      // Ensure proper cleanup on error
      this.error = error.message;
      await this.disconnect();

      throw new ConnectionError("Failed to establish server connection", {
        server: this.name,
        error: error.message,
      });
    }
  }

  async updateCapabilities() {
    // Helper function to safely request capabilities
    const safeRequest = async (method, schema) => {
      try {
        const response = await this.client.request({ method }, schema);
        return response;
      } catch (error) {
        logger.warn(`Server does not support ${method}`, {
          server: this.name,
          error: error.message,
        });
        return null;
      }
    };

    try {
      // Fetch all capabilities before updating state
      const [templatesResponse, toolsResponse, resourcesResponse] =
        await Promise.all([
          safeRequest(
            "resources/templates/list",
            ListResourceTemplatesResultSchema
          ),
          safeRequest("tools/list", ListToolsResultSchema),
          safeRequest("resources/list", ListResourcesResultSchema),
        ]);

      // Update local state atomically, defaulting to empty arrays if capability not supported
      this.resourceTemplates = templatesResponse?.resourceTemplates || [];
      this.tools = toolsResponse?.tools || [];
      this.resources = resourcesResponse?.resources || [];

      logger.info("Updated server capabilities", {
        server: this.name,
        toolCount: this.tools.length,
        resourceCount: this.resources.length,
        templateCount: this.resourceTemplates.length,
        supportedCapabilities: {
          tools: !!toolsResponse,
          resources: !!resourcesResponse,
          resourceTemplates: !!templatesResponse,
        },
      });
    } catch (error) {
      // Only log as warning since missing capabilities are expected in some cases
      logger.warn("Error updating capabilities", {
        server: this.name,
        error: error.message,
      });

      // Reset capabilities to empty arrays
      this.resourceTemplates = [];
      this.tools = [];
      this.resources = [];
    }
  }

  /*
  * | Scenario            | Example Response                                                                 |
    |---------------------|----------------------------------------------------------------------------------|
    | Text Output         | `{ "content": [{ "type": "text", "text": "Hello, World!" }], "isError": false }` |
    | Image Output        | `{ "content": [{ "type": "image", "data": "base64data...", "mimeType": "image/png" }], "isError": false }` |
    | Text Resource       | `{ "content": [{ "type": "resource", "resource": { "uri": "file.txt", "text": "Content" } }], "isError": false }` |
    | Binary Resource     | `{ "content": [{ "type": "resource", "resource": { "uri": "image.jpg", "blob": "base64data...", "mimeType": "image/jpeg" } }], "isError": false }` |
    | Error Case          | `{ "content": [], "isError": true }` (Note: Error details might be in JSON-RPC level) |
    */
  async callTool(toolName, args) {
    if (!this.client) {
      throw new ToolError("Server not initialized", {
        server: this.name,
        tool: toolName,
      });
    }

    if (this.status !== "connected") {
      throw new ToolError("Server not connected", {
        server: this.name,
        tool: toolName,
        status: this.status,
      });
    }

    const tool = this.tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new ToolError("Tool not found", {
        server: this.name,
        tool: toolName,
        availableTools: this.tools.map((t) => t.name),
      });
    }

    //check args, it should be either a list or an object or null
    if (args && !Array.isArray(args) && typeof args !== "object") {
      throw new ToolError("Invalid arguments", {
        server: this.name,
        tool: toolName,
        args,
      });
    }

    try {
      return await this.client.request(
        {
          method: "tools/call",
          params: {
            name: toolName,
            arguments: args,
          },
        },
        CallToolResultSchema
      );
    } catch (error) {
      throw wrapError(error, "TOOL_EXECUTION_ERROR", {
        server: this.name,
        tool: toolName,
        args,
      });
    }
  }

  /*
  * | Scenario                     | Example Response                                                                 |
    |------------------------------|----------------------------------------------------------------------------------|
    | Text Resource                | `{ "contents": [{ "uri": "file.txt", "text": "This is the content of the file." }] }` |
    | Binary Resource without `mimeType` | `{ "contents": [{ "uri": "image.jpg", "blob": "base64encodeddata..." }] }`         |
    | Binary Resource with `mimeType` | `{ "contents": [{ "uri": "image.jpg", "mimeType": "image/jpeg", "blob": "base64encodeddata..." }] }` |
    | Multiple Resources           | `{ "contents": [{ "uri": "file1.txt", "text": "Content of file1" }, { "uri": "file2.png", "blob": "base64encodeddata..." }] }` |
    | No Resources (empty)         | `{ "contents": [] }`                                                             |
  */

  async readResource(uri) {
    if (!this.client) {
      throw new ResourceError("Server not initialized", {
        server: this.name,
        uri,
      });
    }

    if (this.status !== "connected") {
      throw new ResourceError("Server not connected", {
        server: this.name,
        uri,
        status: this.status,
      });
    }

    const isValidResource =
      this.resources.some((r) => r.uri === uri) ||
      this.resourceTemplates.some((t) => {
        // Convert template to regex pattern
        const pattern = t.uriTemplate.replace(/\{[^}]+\}/g, "[^/]+");
        return new RegExp(`^${pattern}$`).test(uri);
      });

    if (!isValidResource) {
      throw new ResourceError("Resource not found", {
        server: this.name,
        uri,
        availableResources: this.resources.map((r) => r.uri),
        availableTemplates: this.resourceTemplates.map((t) => t.uriTemplate),
      });
    }

    try {
      return await this.client.request(
        {
          method: "resources/read",
          params: { uri },
        },
        ReadResourceResultSchema
      );
    } catch (error) {
      throw wrapError(error, "RESOURCE_READ_ERROR", {
        server: this.name,
        uri,
      });
    }
  }

  async disconnect() {
    if (this.transport) {
      await this.transport.close();
    }
    if (this.client) {
      await this.client.close();
    }
    this.status = "disconnected";
    this.startTime = null;
    this.client = null;
    this.transport = null;
  }

  getServerInfo() {
    return {
      name: this.name,
      status: this.status,
      error: this.error,
      capabilities: {
        tools: this.tools,
        resources: this.resources,
        resourceTemplates: this.resourceTemplates,
      },
      uptime: this.getUptime(),
      lastStarted: this.lastStarted,
    };
  }
}
