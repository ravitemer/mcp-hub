import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import ReconnectingEventSource from "reconnecting-eventsource";
import {
  ListToolsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  CallToolResultSchema,
  ReadResourceResultSchema,
  LoggingMessageNotificationSchema,
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  ListPromptsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import EventEmitter from "events";
import logger from "./utils/logger.js";
import {
  ConnectionError,
  ToolError,
  ResourceError,
  wrapError,
} from "./utils/errors.js";

export class MCPConnection extends EventEmitter {
  constructor(name, config, marketplace) {
    super();
    this.name = name; // Keep as mcpId

    // Set display name from marketplace
    this.displayName = name; // Default to mcpId
    let serverDescription = ""
    if (marketplace?.cache?.catalog?.items) {
      const item = marketplace.cache.catalog.items.find(
        (item) => item.mcpId === name
      );
      if (item?.name) {
        this.displayName = item.name;
        serverDescription = item.description || ""
        logger.debug(`Using marketplace name for server '${name}'`, {
          name,
          displayName: item.name,
        });
      }
    }

    this.config = config;
    this.description = config.description ? config.description : serverDescription
    this.client = null;
    this.transport = null;
    this.transportType = config.type; // Store the transport type from config
    this.tools = [];
    this.resources = [];
    this.prompts = [];
    this.resourceTemplates = [];
    this.status = config.disabled ? "disabled" : "disconnected"; // disabled | disconnected | connecting | connected
    this.error = null;
    this.startTime = null;
    this.lastStarted = null;
    this.disabled = config.disabled || false;
  }

  async start() {
    // If disabled, enable it
    if (this.disabled) {
      this.disabled = false;
      this.config.disabled = false;
      this.status = "disconnected";
    }

    // If already connected, return current state
    if (this.status === "connected") {
      return this.getServerInfo();
    }

    await this.connect();
    return this.getServerInfo();
  }

  async stop(disable = false) {
    if (disable) {
      this.disabled = true;
      this.config.disabled = true;
    }

    // if (this.status !== "disconnected") {
    await this.disconnect();
    // }

    return this.getServerInfo();
  }

  // Calculate uptime in seconds
  getUptime() {
    if (!this.startTime || !["connected", "disabled"].includes(this.status)) {
      return 0;
    }
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  async connect() {
    try {
      if (this.disabled) {
        this.status = "disabled";
        this.startTime = Date.now(); // Track uptime even when disabled
        this.lastStarted = new Date().toISOString();
        return;
      }

      this.error = null;
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

      const env = this.config.env || {};

      // For each key in env, use process.env as fallback if value is falsy
      // This means empty string, null, undefined etc. will fall back to process.env value
      // Example: { API_KEY: "" } or { API_KEY: null } will use process.env.API_KEY
      Object.keys(env).forEach((key) => {
        env[key] = env[key] ? env[key] : process.env[key];
      });

      // Create appropriate transport based on transport type
      if (this.transportType === 'sse') {
        // SSE transport setup with reconnection support
        const reconnectingEventSourceOptions = {
          max_retry_time: 5000, // Maximum time between retries (5 seconds)
          withCredentials: this.config.headers?.["Authorization"] ? true : false,
        };

        // Use ReconnectingEventSource for automatic reconnection
        global.EventSource = ReconnectingEventSource;

        this.transport = new SSEClientTransport(new URL(this.config.url), {
          requestInit: {
            headers: this.config.headers || {},
          },
          eventSourceInit: reconnectingEventSourceOptions
        });

        // Log reconnection attempts
        if (this.transport.eventSource) {
          this.transport.eventSource.onretry = (event) => {
            logger.info(`Attempting to reconnect to SSE server '${this.name}'`, {
              server: this.name,
              attempt: event.retryCount,
              delay: event.retryDelay
            });
          };
        }
      } else {
        // Default to STDIO transport
        this.transport = new StdioClientTransport({
          command: this.config.command,
          args: this.config.args || [],
          env: {
            //INFO: getDefaultEnvironment is imp in order to start mcp servers properly
            ...getDefaultEnvironment(),
            ...(process.env.MCP_ENV_VARS
              ? JSON.parse(process.env.MCP_ENV_VARS)
              : {}),
            ...env,
          },
          stderr: "pipe",
        });
      }

      // Handle transport errors with transport-specific details
      this.transport.onerror = (error) => {
        const errorDetails = {
          server: this.name,
          type: this.transportType,
          error: error.message,
        };

        // Add transport-specific error details
        if (this.transportType === 'sse') {
          errorDetails.url = this.config.url;
          if (error instanceof Error && error.cause) {
            errorDetails.cause = error.cause;
          }
        }

        const connectionError = new ConnectionError(
          `Failed to communicate with ${this.transportType} server`,
          errorDetails
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

        // Emit error event for handling at higher levels
        this.emit("connectionError", connectionError);
      };

      this.transport.onclose = () => {
        logger.info(
          `${this.transportType.toUpperCase()} transport connection closed for server '${this.name}'`,
          {
            server: this.name,
            type: this.transportType,
            ...(this.transportType === 'sse' ? { url: this.config.url } : {})
          }
        );
        this.status = "disconnected";
        this.startTime = null;

        // Emit close event for handling reconnection if needed
        this.emit("connectionClosed", {
          server: this.name,
          type: this.transportType
        });
      };

      // Set up stderr handling before connecting (STDIO only)
      if (this.transportType !== 'sse') {
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
      }

      // Connect client (this will start the transport)
      await this.client.connect(this.transport);

      // Fetch initial capabilities before marking as connected
      await this.updateCapabilities();

      // Set up notification handlers
      this.setupNotificationHandlers();

      // Only mark as connected after capabilities are fetched
      this.status = "connected";
      this.startTime = Date.now();
      this.error = null;

      logger.info(`'${this.name}' MCP server connected`, {
        server: this.name,
        tools: this.tools.length,
        resources: this.resources.length,
      });
    } catch (error) {
      // Ensure proper cleanup on error
      await this.disconnect(error.message);

      throw new ConnectionError(
        `Failed to connect to "${this.name}" MCP server: ${error.message}`,
        {
          server: this.name,
          error: error.message,
        }
      );
    }
  }

  removeNotificationHandlers() {
    this.client.removeNotificationHandler(ToolListChangedNotificationSchema)
    this.client.removeNotificationHandler(ResourceListChangedNotificationSchema)
    this.client.removeNotificationHandler(PromptListChangedNotificationSchema)
    this.client.removeNotificationHandler(LoggingMessageNotificationSchema)
  }
  setupNotificationHandlers() {
    // Handle tool list changes
    this.client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => {
        logger.debug(
          `Received tools list changed notification from ${this.name}`
        );
        await this.updateCapabilities();
        this.emit("toolsChanged", {
          server: this.name,
          tools: this.tools,
        });
      }
    );

    // Handle resource list changes
    this.client.setNotificationHandler(
      ResourceListChangedNotificationSchema,
      async () => {
        logger.debug(
          `Received resources list changed notification from ${this.name}`
        );
        await this.updateCapabilities();
        this.emit("resourcesChanged", {
          server: this.name,
          resources: this.resources,
          resourceTemplates: this.resourceTemplates,
        });
      }
    );
    this.client.setNotificationHandler(
      PromptListChangedNotificationSchema,
      async () => {
        logger.debug(
          `Received prompts list changed notification from ${this.name}`
        );
        await this.updateCapabilities();
        this.emit("promptsChanged", {
          server: this.name,
          prompts: this.prompts,
        });
      })

    // Handle general logging messages
    this.client.setNotificationHandler(
      LoggingMessageNotificationSchema,
      (notification) => {
        let params = notification.params || {}
        let data = params.data || {}
        let level = params.level || "debug"
        logger.debug(`["${this.name}" server ${level} log]: ${JSON.stringify(data, null, 2)}`);
      }
    );
  }


  async updateCapabilities() {
    //skip for disabled servers
    if (!this.client) {
      return;
    }
    // Helper function to safely request capabilities
    const safeRequest = async (method, schema) => {
      try {
        const response = await this.client.request({ method }, schema);
        return response;
      } catch (error) {
        // logger.debug(
        //   `Server '${this.name}' does not support capability '${method}'`,
        //   {
        //     server: this.name,
        //     error: error.message,
        //   }
        // );
        return null;
      }
    };

    try {
      // Fetch all capabilities before updating state
      const [templatesResponse, toolsResponse, resourcesResponse, promptsResponse] =
        await Promise.all([
          safeRequest(
            "resources/templates/list",
            ListResourceTemplatesResultSchema
          ),
          safeRequest("tools/list", ListToolsResultSchema),
          safeRequest("resources/list", ListResourcesResultSchema),
          safeRequest("prompts/list", ListPromptsResultSchema),
        ]);

      // Update local state atomically, defaulting to empty arrays if capability not supported
      //TODO: handle pagination
      this.resourceTemplates = templatesResponse?.resourceTemplates || [];
      this.tools = toolsResponse?.tools || [];
      this.resources = resourcesResponse?.resources || [];
      this.prompts = promptsResponse?.prompts || [];

      // logger.info(`Updated capabilities for server '${this.name}'`, {
      //   server: this.name,
      //   toolCount: this.tools.length,
      //   resourceCount: this.resources.length,
      //   templateCount: this.resourceTemplates.length,
      //   supportedCapabilities: {
      //     tools: !!toolsResponse,
      //     resources: !!resourcesResponse,
      //     resourceTemplates: !!templatesResponse,
      //   },
      // });
    } catch (error) {
      // Only log as warning since missing capabilities are expected in some cases
      logger.warn(`Error updating capabilities for server '${this.name}'`, {
        server: this.name,
        error: error.message,
      });

      // Reset capabilities to empty arrays
      this.resourceTemplates = [];
      this.tools = [];
      this.resources = [];
      this.prompts = [];
    }
  }


  async getPrompt(promptName, args) {
    if (!this.client) {
      throw new ToolError("Server not initialized", {
        server: this.name,
        prompt: promptName,
      });
    }
    if (this.status !== "connected") {
      throw new ToolError("Server not connected", {
        server: this.name,
        prompt: promptName,
        status: this.status,
      });
    }

    const prompt = this.prompts.find((p) => p.name === promptName);
    if (!prompt) {
      throw new ToolError("Prompt not found", {
        server: this.name,
        prompt: promptName,
        availablePrompts: this.prompts.map((p) => p.name),
      });
    }
    //check args, it should be either a list or an object or null
    if (args && !Array.isArray(args) && typeof args !== "object") {
      throw new ToolError("Invalid arguments", {
        server: this.name,
        prompt: promptName,
        args,
      });
    }

    try {
      return await this.client.getPrompt({
        name: promptName,
        arguments: args,
      })
    } catch (error) {
      throw wrapError(error, "PROMPT_EXECUTION_ERROR", {
        server: this.name,
        prompt: promptName,
        args,
      });
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
      throw new ResourceError(`Resource not found : ${uri}`, {
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



  async resetState(error) {
    this.client = null;
    this.transport = null;
    this.tools = [];
    this.resources = [];
    this.prompts = [];
    this.resourceTemplates = [];
    this.status = this.config.disabled ? "disabled" : "disconnected"; // disabled | disconnected | connecting | connected
    this.error = error || null;
    this.startTime = null;
    this.lastStarted = null;
    this.disabled = this.config.disabled || false;
  }

  async disconnect(error) {
    if (this.client) {
      this.removeNotificationHandlers();
      await this.client.close();
    }
    if (this.transport) {
      await this.transport.close();
    }

    this.resetState(error);
  }

  getServerInfo() {
    return {
      name: this.name, // Original mcpId
      displayName: this.displayName, // Friendly name from marketplace
      description: this.description,
      transportType: this.transportType, // Include transport type in server info
      status: this.status,
      error: this.error,
      capabilities: {
        tools: this.tools,
        resources: this.resources,
        resourceTemplates: this.resourceTemplates,
        prompts: this.prompts,
      },
      uptime: this.getUptime(),
      lastStarted: this.lastStarted,
    };
  }
}
