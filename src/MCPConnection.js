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
        logger.error({
          message: "Transport error",
          server: this.name,
          error: error.message,
        });
        this.error = error.message;
        this.status = "disconnected";
        this.startTime = null;
      };

      this.transport.onclose = () => {
        logger.info({
          message: "Transport closed",
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
          logger.error({
            message: "Server stderr",
            server: this.name,
            error: errorOutput,
          });
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

      logger.info({
        message: "MCP client connected",
        server: this.name,
        tools: this.tools.length,
        resources: this.resources.length,
      });
    } catch (error) {
      // Ensure proper cleanup on error
      this.error = error.message;
      await this.disconnect();
      throw error;
    }
  }

  async updateCapabilities() {
    // Helper function to safely request capabilities
    const safeRequest = async (method, schema) => {
      try {
        const response = await this.client.request({ method }, schema);
        return response;
      } catch (error) {
        logger.warn({
          message: `Server does not support ${method}`,
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

      logger.info({
        message: "Updated server capabilities",
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
      logger.warn({
        message: "Error updating capabilities",
        server: this.name,
        error: error.message,
      });

      // Reset capabilities to empty arrays
      this.resourceTemplates = [];
      this.tools = [];
      this.resources = [];
    }
  }

  async callTool(toolName, args) {
    if (!this.client) {
      throw new Error(`Server "${this.name}" is not initialized`);
    }

    if (this.status !== "connected") {
      throw new Error(`Server "${this.name}" is not connected`);
    }

    const tool = this.tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new Error(`Tool "${toolName}" not found on server "${this.name}"`);
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
      logger.error({
        message: "Tool execution failed",
        server: this.name,
        tool: toolName,
        error: error.message,
      });
      throw error;
    }
  }

  async readResource(uri) {
    if (!this.client) {
      throw new Error(`Server "${this.name}" is not initialized`);
    }

    if (this.status !== "connected") {
      throw new Error(`Server "${this.name}" is not connected`);
    }

    const isValidResource =
      this.resources.some((r) => r.uri === uri) ||
      this.resourceTemplates.some((t) => {
        // Convert template to regex pattern
        const pattern = t.uriTemplate.replace(/\{[^}]+\}/g, "[^/]+");
        return new RegExp(`^${pattern}$`).test(uri);
      });

    if (!isValidResource) {
      throw new Error(`Resource "${uri}" not found on server "${this.name}"`);
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
      logger.error({
        message: "Resource read failed",
        server: this.name,
        uri,
        error: error.message,
      });
      throw error;
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
