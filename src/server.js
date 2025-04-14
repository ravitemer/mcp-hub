import express from "express";
import logger from "./utils/logger.js";
import { MCPHub } from "./MCPHub.js";
import { SSEManager, EventTypes, HubState, SubscriptionTypes } from "./utils/sse-manager.js";
import {
  router,
  registerRoute,
  generateStartupMessage,
} from "./utils/router.js";
import {
  ValidationError,
  ServerError,
  isMCPHubError,
  wrapError,
} from "./utils/errors.js";
import { getMarketplace } from "./marketplace.js";

const SERVER_ID = "mcp-hub";

// Create Express app
const app = express();
app.use(express.json());
app.use("/api", router);

// Helper to determine HTTP status code from error type
function getStatusCode(error) {
  if (error instanceof ValidationError) return 400;
  if (error instanceof ServerError) return 500;
  if (error.code === "SERVER_NOT_FOUND") return 404;
  if (error.code === "SERVER_NOT_CONNECTED") return 503;
  if (error.code === "TOOL_NOT_FOUND" || error.code === "RESOURCE_NOT_FOUND")
    return 404;
  return 500;
}

let serviceManager = null;
let marketplace = null;

class ServiceManager {
  constructor(options = {}) {
    this.config = options.config;
    this.port = options.port;
    this.autoShutdown = options.autoShutdown;
    this.shutdownDelay = options.shutdownDelay;
    this.watch = options.watch;
    this.mcpHub = null;
    this.server = null;
    this.sseManager = new SSEManager(options);
    this.state = 'starting';
    // Connect logger to SSE manager
    logger.setSseManager(this.sseManager);
  }
  isReady() {
    return this.state === HubState.READY
  }

  getState(extraData = {}) {
    return {
      state: this.state,
      server_id: SERVER_ID,
      pid: process.pid,
      port: this.port,
      timestamp: new Date().toISOString(),
      ...extraData
    }
  }

  setState(newState, extraData) {
    this.state = newState;
    this.broadcastHubState(extraData);
  }

  /**
   * Broadcasts current hub state to all clients
   * @private
   */
  broadcastHubState(extraData = {}) {
    this.sseManager.broadcast(EventTypes.HUB_STATE, this.getState(extraData));
  }

  broadcastSubscriptionEvent(eventType, data = {}) {
    this.sseManager.broadcast(EventTypes.SUBSCRIPTION_EVENT, {
      type: eventType,
      ...data
    });
  }

  async initializeMCPHub() {
    // Initialize marketplace first
    logger.info("Initializing marketplace catalog");
    marketplace = getMarketplace();
    await marketplace.initialize();
    logger.info("Marketplace initialized", {
      catalogItems: marketplace.cache.catalog.items.length,
    });

    // Then initialize MCP Hub
    logger.info("Initializing MCP Hub");
    this.mcpHub = new MCPHub(this.config, {
      watch: this.watch,
      marketplace,
    });

    // Setup event handlers
    this.mcpHub.on("configChangeDetected", (data) => {
      this.broadcastSubscriptionEvent(SubscriptionTypes.CONFIG_CHANGED, data)
    });

    // Setup event handlers
    this.mcpHub.on("importantConfigChanged", (changes) => {
      this.broadcastSubscriptionEvent(SubscriptionTypes.SERVERS_UPDATING, { changes })
    });
    this.mcpHub.on("importantConfigChangeHandled", (changes) => {
      this.broadcastSubscriptionEvent(SubscriptionTypes.SERVERS_UPDATED, { changes })
    });

    // Server-specific events
    this.mcpHub.on("toolsChanged", (data) => {
      this.broadcastSubscriptionEvent(SubscriptionTypes.TOOLS_CHANGED, data)
    });

    this.mcpHub.on("resourcesChanged", (data) => {
      this.broadcastSubscriptionEvent(SubscriptionTypes.RESOURCE_LIST_CHANGED, data)
    });

    this.mcpHub.on("promptsChanged", (data) => {
      this.broadcastSubscriptionEvent(SubscriptionTypes.PROMPT_LIST_CHANGED, data)
    });

    await this.mcpHub.initialize();
    this.setState(HubState.READY)
  }

  async restartHub() {
    if (this.mcpHub) {
      this.setState(HubState.RESTARTING)
      logger.info("Restarting MCP Hub");
      await this.mcpHub.initialize(true);
      logger.info("MCP Hub restarted successfully");
      this.setState(HubState.RESTARTED, { has_restarted: true })
    }
  }

  async startServer() {
    return new Promise((resolve, reject) => {
      logger.info(`Starting HTTP server on port ${this.port}`, {
        port: this.port,
      });

      this.server = app.listen(this.port, () => {
        logger.info("HTTP_SERVER_STARTED");
        resolve();
      });

      this.server.on("error", (error) => {
        this.setState(HubState.ERROR, { message: error.message, code: error.code })
        reject(
          wrapError(error, "HTTP_SERVER_ERROR", {
            port: this.port,
          })
        );
      });
    });
  }

  async stopServer() {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        logger.warn(
          "HTTP server is already stopped and cannot be stopped again"
        );
        resolve();
        return;
      }

      logger.info("Stopping HTTP server and closing all connections");
      this.server.close((error) => {
        if (error) {
          logger.error(
            "SERVER_STOP_ERROR",
            "Failed to stop HTTP server",
            {
              error: error.message,
              stack: error.stack,
            },
            false
          );
          reject(wrapError(error, "SERVER_STOP_ERROR"));
          return;
        }

        logger.info("HTTP server has been successfully stopped");
        this.server = null;
        resolve();
      });
    });
  }

  async stopMCPHub() {
    if (!this.mcpHub) {
      logger.warn("MCP Hub is already stopped and cannot be stopped again");
      return;
    }

    logger.info("Stopping MCP Hub and cleaning up resources");
    try {
      await this.mcpHub.cleanup();
      logger.info("MCP Hub has been successfully stopped and cleaned up");
      this.mcpHub = null;
    } catch (error) {
      logger.error(
        "HUB_STOP_ERROR",
        "Failed to stop MCP Hub",
        {
          error: error.message,
          stack: error.stack,
        },
        false
      );
    }
  }

  setupSignalHandlers() {
    const shutdown = (signal) => async () => {
      logger.info(`Received ${signal} signal - initiating graceful shutdown`, {
        signal,
      });
      try {
        await this.shutdown();
        logger.info("Graceful shutdown completed successfully");
        process.exit(0);
      } catch (error) {
        logger.error(
          "SHUTDOWN_ERROR",
          "Shutdown failed",
          {
            error: error.message,
            stack: error.stack,
          },
          true,
          1
        );
      }
    };

    process.on("SIGTERM", shutdown("SIGTERM"));
    process.on("SIGINT", shutdown("SIGINT"));
  }

  async shutdown() {
    this.setState(HubState.STOPPING)
    logger.info("Starting graceful shutdown process");
    await Promise.allSettled([this.stopMCPHub(), this.sseManager.shutdown(), this.stopServer()]);
    this.setState(HubState.STOPPED)
  }
}

// Register SSE endpoint
registerRoute("GET", "/events", "Subscribe to server events", (req, res) => {
  try {
    if (!serviceManager?.sseManager) {
      throw new ServerError("SSE manager not initialized");
    }
    // Add client connection
    const connection = serviceManager.sseManager.addConnection(req, res);
    // Send initial state
    serviceManager.broadcastHubState();
  } catch (error) {
    logger.error('SSE_SETUP_ERROR', 'Failed to setup SSE connection', {
      error: error.message,
      stack: error.stack
    });

    // Ensure response is ended
    if (!res.writableEnded) {
      res.status(500).end();
    }
  }
});

// Register marketplace endpoints
registerRoute(
  "GET",
  "/marketplace",
  "Get marketplace catalog with filtering and sorting",
  async (req, res) => {
    const { search, category, tags, sort } = req.query;
    try {
      const items = await marketplace.getCatalog({
        search,
        category,
        tags: tags ? tags.split(",") : undefined,
        sort,
      });
      res.json({
        items,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "MARKETPLACE_ERROR", {
        query: req.query,
      });
    }
  }
);

registerRoute(
  "POST",
  "/marketplace/details",
  "Get detailed server information",
  async (req, res) => {
    const { mcpId } = req.body;
    try {
      if (!mcpId) {
        throw new ValidationError("Missing mcpId in request body");
      }

      const details = await marketplace.getServerDetails(mcpId);
      if (!details) {
        throw new ValidationError("Server not found", { mcpId });
      }

      res.json({
        server: details,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "MARKETPLACE_ERROR", {
        mcpId: req.body.mcpId,
      });
    }
  }
);

// Register server start endpoint
registerRoute(
  "POST",
  "/servers/start",
  "Start a server",
  async (req, res) => {
    const { server_name } = req.body;
    try {
      if (!server_name) {
        throw new ValidationError("Missing server name", { field: "server_name" });
      }
      const status = await serviceManager.mcpHub.startServer(server_name);
      serviceManager.broadcastSubscriptionEvent(SubscriptionTypes.SERVERS_UPDATED, {
        changes: {
          modified: [server_name],
        }
      })
      res.json({
        status: "ok",
        server: status,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "SERVER_START_ERROR", { server: server_name });
    }
  }
);

// Register server stop endpoint
registerRoute(
  "POST",
  "/servers/stop",
  "Stop a server",
  async (req, res) => {
    const { server_name } = req.body;
    try {
      if (!server_name) {
        throw new ValidationError("Missing server name", { field: "server_name" });
      }
      const { disable } = req.query;
      const status = await serviceManager.mcpHub.stopServer(
        server_name,
        disable === "true"
      );
      serviceManager.broadcastSubscriptionEvent(SubscriptionTypes.SERVERS_UPDATED, {
        changes: {
          modified: [server_name],
        }
      })
      res.json({
        status: "ok",
        server: status,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "SERVER_STOP_ERROR", { server: server_name });
    }
  }
);

// Register health check endpoint
registerRoute("GET", "/health", "Check server health", (req, res) => {
  res.json({
    status: "ok",
    state: serviceManager?.state || HubState.STARTING,
    server_id: SERVER_ID,
    activeClients: serviceManager?.sseManager?.connections.size || 0,
    timestamp: new Date().toISOString(),
    servers: serviceManager?.mcpHub?.getAllServerStatuses() || [],
    connections: serviceManager?.sseManager?.getStats() || { totalConnections: 0, connections: [] }
  });
});

// Register server list endpoint
registerRoute(
  "GET",
  "/servers",
  "List all MCP servers and their status",
  (req, res) => {
    const servers = serviceManager.mcpHub.getAllServerStatuses();
    res.json({
      servers,
      timestamp: new Date().toISOString(),
    });
  }
);

// Register server info endpoint
registerRoute(
  "POST",
  "/servers/info",
  "Get status of a specific server",
  (req, res) => {
    const { server_name } = req.body;
    try {
      if (!server_name) {
        throw new ValidationError("Missing server name", { field: "server_name" });
      }
      const status = serviceManager.mcpHub.getServerStatus(server_name
      );
      res.json({
        server: status,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "SERVER_NOT_FOUND", {
        server: server_name
      });
    }
  }
);

// Reloads the config file, disconnects all existing servers, and reconnects servers from the new config
registerRoute("POST", "/restart", "Restart MCP Hub", async (req, res) => {
  try {
    await serviceManager.restartHub();
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    throw wrapError(error, "HUB_RESTART_ERROR");
  }
})

// Register server refresh endpoint
registerRoute(
  "POST",
  "/servers/refresh",
  "Refresh a server's capabilities",
  async (req, res) => {
    const { server_name } = req.body;
    try {
      if (!server_name) {
        throw new ValidationError("Missing server name", { field: "server_name" });
      }
      const info = await serviceManager.mcpHub.refreshServer(server_name);
      res.json({
        status: "ok",
        server: info,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "SERVER_REFRESH_ERROR", { server: server_name });
    }
  }
);

// Register all servers refresh endpoint
registerRoute(
  "GET",
  "/refresh",
  "Refresh all servers' capabilities",
  async (req, res) => {
    try {
      const results = await serviceManager.mcpHub.refreshAllServers();
      res.json({
        status: "ok",
        servers: results,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "SERVERS_REFRESH_ERROR");
    }
  }
);

//Register prompt endpoint

registerRoute(
  "POST",
  "/servers/prompts",
  "Get a prompt from a specific server",
  async (req, res) => {

    const { server_name, prompt, arguments: args } = req.body;
    try {

      if (!server_name) {
        throw new ValidationError("Missing server name", { field: "server_name" });
      }
      if (!prompt) {
        throw new ValidationError("Missing prompt name", { field: "prompt" });
      }
      const result = await serviceManager.mcpHub.getPrompt(
        server_name,
        prompt,
        args || {}
      );
      res.json({
        result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, error.code || "PROMPT_EXECUTION_ERROR", {
        server: server_name,
        prompt,
        ...(error.data || {}),
      });
    }
  }
)


// Register tool execution endpoint
registerRoute(
  "POST",
  "/servers/tools",
  "Execute a tool on a specific server",
  async (req, res) => {

    const { server_name, tool, arguments: args } = req.body;
    try {

      if (!server_name) {
        throw new ValidationError("Missing server name", { field: "server_name" });
      }
      if (!tool) {
        throw new ValidationError("Missing tool name", { field: "tool" });
      }
      const result = await serviceManager.mcpHub.callTool(
        server_name,
        tool,
        args || {}
      );
      res.json({
        result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, error.code || "TOOL_EXECUTION_ERROR", {
        server: server_name,
        tool,
        ...(error.data || {}),
      });
    }
  }
);

// Register resource access endpoint
registerRoute(
  "POST",
  "/servers/resources",
  "Access a resource on a specific server",
  async (req, res) => {

    const { server_name, uri } = req.body;
    try {

      if (!server_name) {
        throw new ValidationError("Missing server name", { field: "server_name" });
      }

      if (!uri) {
        throw new ValidationError("Missing resource URI", { field: "uri" });
      }
      const result = await serviceManager.mcpHub.readResource(server_name, uri);
      res.json({
        result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, error.code || "RESOURCE_READ_ERROR", {
        server: server_name,
        uri,
        ...(error.data || {}),
      });
    }
  }
);

// Error handler middleware
router.use((err, req, res, next) => {
  // Determine if it's our custom error or needs wrapping
  const error = isMCPHubError(err)
    ? err
    : wrapError(err, "REQUEST_ERROR", {
      path: req.path,
      method: req.method,
    });

  // Only send error response if headers haven't been sent
  if (!res.headersSent) {
    res.status(getStatusCode(error)).json({
      error: error.message,
      code: error.code,
      data: error.data,
      timestamp: new Date().toISOString(),
    });
  }
});

// Start the server with options
export async function startServer(options = {}) {
  serviceManager = new ServiceManager(options);

  try {
    serviceManager.setupSignalHandlers();

    // Start HTTP server first to fail fast on port conflicts
    await serviceManager.startServer();

    // Then initialize MCP Hub
    await serviceManager.initializeMCPHub();
  } catch (error) {
    const wrappedError = wrapError(error, error.code || "SERVER_START_ERROR");
    try {
      this.setState(HubState.ERROR, {
        message: wrappedError.message,
        code: wrappedError.code,
        data: wrappedError.data,
      })
      await serviceManager.shutdown()
    } catch (e) {
    } finally {
      logger.error(
        wrappedError.code,
        wrappedError.message,
        wrappedError.data,
        true,
        1
      );
    }
  }
}

export default app;
