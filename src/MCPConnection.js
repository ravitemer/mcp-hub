import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import ReconnectingEventSource from "reconnecting-eventsource";
import MCPHubOAuthProvider from "./utils/oauth-provider.js"
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
import open from "open";
import {
  ConnectionError,
  ToolError,
  ResourceError,
  wrapError,
} from "./utils/errors.js";

const ConnectionStatus = {
  CONNECTED: "connected",
  CONNECTING: "connecting",
  DISCONNECTED: "disconnected",
  UNAUTHORIZED: "unauthorized", // New status for OAuth flow
  DISABLED: "disabled"
};


export class MCPConnection extends EventEmitter {
  constructor(name, config, marketplace, hubServerUrl) {
    super();
    this.name = name; // Keep as mcpId

    // OAuth state
    this.authProvider = null;
    this.authCallback = null;
    this.authCode = null;

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
    this.status = config.disabled ? ConnectionStatus.DISABLED : ConnectionStatus.DISCONNECTED;
    this.error = null;
    this.startTime = null;
    this.lastStarted = null;
    this.disabled = config.disabled || false;
    this.authorizationUrl = null;
    this.hubServerUrl = hubServerUrl
  }

  async start() {
    // If disabled, enable it
    if (this.disabled) {
      this.disabled = false;
      this.config.disabled = false;
      this.status = ConnectionStatus.DISCONNECTED;
    }

    // If already connected, return current state
    if (this.status === ConnectionStatus.CONNECTED) {
      return this.getServerInfo();
    }

    await this.connect();
    return this.getServerInfo();
  }

  async stop(disable = false) {
    if (disable) {
      this.disabled = true;
      this.config.disabled = true;
      this.status = ConnectionStatus.DISABLED;
    }

    // if (this.status !== "disconnected") {
    await this.disconnect();
    // }

    return this.getServerInfo();
  }

  // Calculate uptime in seconds
  getUptime() {
    if (!this.startTime || ![ConnectionStatus.CONNECTED, ConnectionStatus.DISABLED].includes(this.status)) {
      return 0;
    }
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  async connect(config) {
    try {
      if (config) {
        this.config = config
      }
      if (this.disabled) {
        this.status = ConnectionStatus.DISABLED;
        this.startTime = Date.now(); // Track uptime even when disabled
        this.lastStarted = new Date().toISOString();
        return;
      }

      this.error = null;
      this.status = ConnectionStatus.CONNECTING;
      this.lastStarted = new Date().toISOString();

      try {
        // Create appropriate transport based on transport type
        if (this.transportType === 'stdio') {
          this.transport = await this._createStdioTransport();
          this.client = this._createClient();
          await this.client.connect(this.transport);
        } else {
          //First try the new http transport with fallback to deprecated sse transport
          try {
            this.authProvider = this._createOAuthProvider()
            this.transport = this._createStreambleHTTPTransport(this.authProvider)
            this.client = this._createClient();
            await this.client.connect(this.transport);
          } catch (httpError) {
            //catches 401 error from http transport
            if (this._isAuthError(httpError)) {
              logger.debug(`'${this.name}' streamable-http transport needs authorization: ${httpError.message}`);
              return this._handleUnauthorizedConnection()
            } else {
              logger.debug(`'${this.name}' streamable-http error: ${httpError.message}. Falling back to SSE transport`);
              this.authProvider = this._createOAuthProvider()
              this.transport = this._createSSETransport(this.authProvider);
              this.client = this._createClient();
              await this.client.connect(this.transport);
            }
          }
        }
      } catch (error) {
        //catches 401 error from sse transport
        if (this._isAuthError(error)) {
          logger.debug(`'${this.name}' SSE transport needs authorization: ${error.message}`);
          return this._handleUnauthorizedConnection()
        } else {
          logger.debug(`'${this.name}' failed to start connection with http and sse transports: ${error.message}`);
          throw error
        }
      }

      // Fetch initial capabilities before marking as connected
      await this.updateCapabilities();

      // Set up notification handlers
      this.setupNotificationHandlers();

      // Only mark as connected after capabilities are fetched
      this.status = ConnectionStatus.CONNECTED;
      this.startTime = Date.now();
      this.error = null;

      logger.info(`'${this.name}' MCP server connected`);
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
    if (!this.client) return
    // Remove all notification handlers
    // For some reason removeNotificationHandlers doesn't seem to work 
    // so we are setting them to nothing
    const nothing = () => { };
    this.client.setNotificationHandler(ToolListChangedNotificationSchema, nothing)
    this.client.setNotificationHandler(ResourceListChangedNotificationSchema, nothing)
    this.client.setNotificationHandler(PromptListChangedNotificationSchema, nothing)
    this.client.setNotificationHandler(LoggingMessageNotificationSchema, nothing)
  }

  setupNotificationHandlers() {
    if (!this.client) return

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
    const map = {
      "tools": ToolListChangedNotificationSchema,
      "resources": ResourceListChangedNotificationSchema,
      "prompts": PromptListChangedNotificationSchema,
    }
    // Handle tool list changes
    Object.keys(map).forEach(type => {
      this.client.setNotificationHandler(map[type], async () => {
        logger.debug(`Received ${type}Changed notification`)
        await this.updateCapabilities(type === "resources" ? ["resources", "resourceTemplates"] : [type]);
        const updatedData = type === "resources" ? {
          resources: this.resources,
          resourceTemplates: this.resourceTemplates,
        } : {
          [type]: this[type],
        }
        this.emit(`${type}Changed`, {
          server: this.name,
          ...updatedData,
        })
      })
    })
  }


  async updateCapabilities(capabilitiesToUpdate) {
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
        // logger.debug( `Server '${this.name}' does not support capability '${method}'`);
        return null;
      }
    };
    const map = {
      tools: {
        method: "tools/list",
        schema: ListToolsResultSchema,
      },
      resources: {
        method: "resources/list",
        schema: ListResourcesResultSchema,
      },
      resourceTemplates: {
        method: "resources/templates/list",
        schema: ListResourceTemplatesResultSchema,
      },
      prompts: {
        method: "prompts/list",
        schema: ListPromptsResultSchema,
      }
    }

    try {
      const typesToFetch = capabilitiesToUpdate || Object.keys(map);
      const fetchPromises = typesToFetch.map(async (type) => {
        this[type] = (await safeRequest(map[type].method, map[type].schema))?.[type] || [];
      });
      await Promise.all(fetchPromises);
      //TODO: handle pagination
    } catch (error) {
      // Only log as warning since missing capabilities are expected in some cases
      logger.warn(`Error updating capabilities for server '${this.name}'`, {
        server: this.name,
        error: error.message,
      });
    }
  }


  async getPrompt(promptName, args) {
    if (!this.client) {
      throw new ToolError("Server not initialized", {
        server: this.name,
        prompt: promptName,
      });
    }
    if (this.status !== ConnectionStatus.CONNECTED) {
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

    if (this.status !== ConnectionStatus.CONNECTED) {
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

    if (this.status !== ConnectionStatus.CONNECTED) {
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
    this.status = this.config.disabled ? ConnectionStatus.DISABLED : ConnectionStatus.DISCONNECTED;
    this.error = error || null;
    this.startTime = null;
    this.lastStarted = null;
    this.disabled = this.config.disabled || false;
    this.authorizationUrl = null;
    this.authProvider = null;
  }

  async disconnect(error) {
    this.removeNotificationHandlers();
    if (this.transport) {
      // First try to terminate the session gracefully
      if (this.transport.sessionId) {
        try {
          logger.debug(`'${this.name}': Terminating session before exit...`);
          await transport.terminateSession();
        }
        catch (error) {
          logger.debug(`'${this.name}': Error terminating session: ${error.message}`)
        }
      }
      await this.transport.close();
    }
    this.resetState(error);
  }

  // Create OAuth provider with proper metadata and storage
  _createOAuthProvider() {
    return new MCPHubOAuthProvider({
      serverName: this.name,
      serverUrl: this.config.url,
      hubServerUrl: this.hubServerUrl
    })
  }

  async authorize() {
    if (!this.authorizationUrl) {
      throw new Error(`No authorization URL available for server '${this.name}'`);
    }
    //validate
    new URL(this.authorizationUrl)
    // log it in cases where the user in a browserless environment
    logger.info(`Opening authorization URL for server '${this.name}': ${this.authorizationUrl.toString()}`);
    // Open the authorization URL in the default browser 
    await open(this.authorizationUrl.toString())
    //Once the user authorizes, handleAuthCallback is called.
    return {
      authorizationUrl: this.authorizationUrl,
    }
  }

  async reconnect() {
    if (this.client) {
      await this.disconnect();
    }
    await this.connect();
  }


  async handleAuthCallback(code) {
    logger.debug(`Handling OAuth callback for server '${this.name}'`);
    await this.transport.finishAuth(code);
    logger.debug(`Successful code exchange for '${this.name}': Authorized, connecting with new tokens`);
    await this.connect()
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
      authorizationUrl: this.authorizationUrl,
    };
  }

  async _createStdioTransport() {
    const env = this.config.env || {};
    const resolvedEnv = {};

    // First pass: Execute commands for vars starting with "$:"
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string' && value.startsWith('$:')) {
        try {
          // Extract command after "$:"
          const command = value.slice(2).trim();
          logger.debug(`Executing command for ${key}`)

          // Execute command and capture output
          const { exec } = await import('child_process');
          const { promisify } = await import('util');
          const execPromise = promisify(exec);

          const { stdout } = await execPromise(command);
          // Store trimmed output
          resolvedEnv[key] = stdout.trim();

          logger.debug(`Successfully resolved command for ${key}`)
        } catch (error) {
          logger.warn(`Failed to execute command for ${key}: ${error.message}`);
          resolvedEnv[key] = env[key]; // Keep original value on error
        }
      }
    }
    // Process env keys in multiple passes to handle forward references
    let unresolved = Object.keys(env);
    let passCount = 0;
    const maxPasses = 10; // Prevent infinite loops for circular dependencies

    while (unresolved.length > 0 && passCount < maxPasses) {
      const nextUnresolved = [];
      unresolved.forEach((key) => {
        if (resolvedEnv[key]) {
          return
        }
        let value = env[key];
        if (typeof value === 'string' && value.match(/\${[^}]+}/)) {
          // Replace ${VARIABLE} placeholders
          const newValue = value.replace(/\${([^}]+)}/g, (match, varName) => {
            // Check resolvedEnv first, then env, then process.env
            if (resolvedEnv[varName]) {
              return resolvedEnv[varName];
            } else if (env[varName]) {
              return env[varName];
            } else if (process.env[varName]) {
              return process.env[varName];
            }
            return match; // Retain placeholder if unresolved
          });
          if (newValue.match(/\${[^}]+}/)) {
            // If placeholders remain, defer to next pass
            nextUnresolved.push(key);
          } else {
            // No unresolved placeholders, store result
            resolvedEnv[key] = newValue ? newValue : process.env[key];
          }
        } else {
          // No placeholders, store result
          resolvedEnv[key] = value ? value : process.env[key];
        }
      });
      unresolved = nextUnresolved;
      passCount++;
    }

    // Check for unresolved placeholders and keep them as is
    if (unresolved.length > 0) {
      logger.error("UNRESOLVED_ENV", `${this.name}: Unresolvable or circular dependencies detected in env while replacing \${} fields: ${unresolved.join(', ')}. Falling back to placeholder value`, {}, false);
      unresolved.forEach((key) => {
        resolvedEnv[key] = env[key]; // Keep unresolved as is
      });
    }
    // Build serverEnv with resolved values
    const serverEnv = {
      // INFO: getDefaultEnvironment is imp in order to start mcp servers properly
      ...getDefaultEnvironment(),
      ...(process.env.MCP_ENV_VARS ? JSON.parse(process.env.MCP_ENV_VARS) : {}),
      ...resolvedEnv,
    };
    // Default to STDIO transport
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: (this.config.args || []).map(arg => {
        // If arg starts with $, replace it with the value from serverEnv, fallback to process.env
        if (arg.startsWith('$')) {
          const envKey = arg.substring(1);
          return serverEnv[envKey] || process.env[envKey] || arg;
        }
        return arg;
      }),
      env: serverEnv,
      stderr: 'pipe',
    });

    //listen to stderr for stdio servers
    const stderrStream = transport.stderr;
    if (stderrStream) {
      stderrStream.on("data", (data) => {
        const errorOutput = data.toString().trim();
        // const error = new ConnectionError("Server error output", {
        //   server: this.name,
        //   error: errorOutput,
        // });
        logger.warn(`${this.name} stderr: ${errorOutput}`)
        // this.error = errorOutput;
      });
    }
    return transport
  }

  _resolveHeaders(headers = {}) {
    const resolvedHeaders = {};

    // Process headers, replacing ${VARIABLE} placeholders with process.env values
    Object.keys(headers).forEach((key) => {
      let value = headers[key];
      if (typeof value === 'string' && value.match(/\${[^}]+}/)) {
        value = value.replace(/\${([^}]+)}/g, (match, varName) => {
          // Replace with process.env value or retain placeholder if undefined
          return process.env[varName] !== undefined ? process.env[varName] : match;
        });
      }
      resolvedHeaders[key] = value;
    });
    return resolvedHeaders
  }

  _createStreambleHTTPTransport(authProvider) {
    const options = {
      authProvider,
      requestInit: {
        headers: this._resolveHeaders(this.config.headers),
      },
      // reconnectionOptions?: StreamableHTTPReconnectionOptions
      // sessionId?: string;
    }
    const transport = new StreamableHTTPClientTransport(new URL(this.config.url), options);
    return transport
  }

  _createSSETransport(authProvider) {
    // SSE transport setup with reconnection support
    const reconnectingEventSourceOptions = {
      max_retry_time: 5000, // Maximum time between retries (5 seconds)
      // withCredentials: this.config.headers?.["Authorization"] ? true : false,
    };

    //HACK: sending reconnectingEventSourceOptions in the SSEClientTransport needs us to create custom fetch function with headers created from authProvider tokens. This way we can use ReconnectingEventSource with necessary options
    class ReconnectingES extends ReconnectingEventSource {
      constructor(url, options) {
        super(url, {
          ...options || {},
          ...reconnectingEventSourceOptions
        })
      }
    }
    // Use ReconnectingEventSource for automatic reconnection
    global.EventSource = ReconnectingES
    const transport = new SSEClientTransport(new URL(this.config.url), {
      requestInit: {
        headers: this._resolveHeaders(this.config.headers),
      },
      authProvider,
      // INFO:: giving eventSourceInit leading to infinite loop, not needed anymore with global ReconnectingES
      // eventSourceInit: reconnectingEventSourceOptions
    });
    return transport
  }

  _createClient() {
    const client = new Client(
      {
        name: "mcp-hub",
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );
    client.onerror = (error) => {
      // logger.error("CLIENT_ERROR", `${this.name}: client error: ${error.message}`, {}, false);
      //INFO: onerror is being called for even minor errors, so debug seems more appropriate
      logger.debug(`'${this.name}' error: ${error.message}`)
    };

    client.onclose = () => {
      logger.debug(`'${this.name}' transport closed`)
      //This is causing a bug where in the frontend the server is shown as disconnected when we try disconnect() which sets to disconnected and again connect() which sets to connecting. Having this here negated the connecting status.
      // this.status = [ConnectionStatus.DISCONNECTED, ConnectionStatus.DISABLED].includes(this.status) ? this.status : ConnectionStatus.DISCONNECTED;
      this.startTime = null;
      // Emit close event for handling reconnection if needed
      this.emit("connectionClosed", {
        server: this.name,
        type: this.transportType
      });
    };
    return client
  }

  _isAuthError(error) {
    return error.code === 401 || error instanceof UnauthorizedError
  }

  _handleUnauthorizedConnection() {
    logger.warn(`Server '${this.name}' requires authorization`);
    this.status = ConnectionStatus.UNAUTHORIZED;
    //our custom oauth provider stores auth url generated from redirecthandler rather than opening url  right away
    this.authorizationUrl = this.authProvider.generatedAuthUrl;
    if (!this.authorizationUrl) {
      logger.warn(`No authorization URL available for server '${this.name}'`);
    }
  }
}
