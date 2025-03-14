import express from "express";
import logger from "./utils/logger.js";
import { MCPHub } from "./MCPHub.js";
import { ClientManager } from "./utils/client-manager.js";
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

// SSE client set
const sseClients = new Set();

// Utility function to broadcast status updates
function broadcastStatusUpdate(metadata = {}) {
  // Send SSE event
  broadcastEvent("server_status", {
    ...metadata,
    timestamp: new Date().toISOString(),
  });

  // Log standardized update message
  logger.logUpdate(metadata);
}

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

// Broadcast capability changes through both SSE and logger
function broadcastCapabilityChange(type, serverName, data = {}) {
  // Send SSE event
  broadcastEvent(`${type.toLowerCase()}_list_changed`, {
    type,
    server: serverName,
    ...data,
    timestamp: new Date().toISOString(),
  });

  // Log standardized update message
  logger.logCapabilityChange(type, serverName, data);
}

// Send event to all SSE clients
function broadcastEvent(event, data) {
  sseClients.forEach((client) => {
    client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });
}

let serviceManager = null;
let clientManager = null;
let marketplace = null;

class ServiceManager {
  constructor(config, port, watch = false, shutdownDelay = 0) {
    this.config = config;
    this.port = port;
    this.shutdownDelay = shutdownDelay;
    this.watch = watch;
    this.mcpHub = null;
    this.server = null;
  }

  async initializeMCPHub() {
    logger.info("Initializing MCP Hub");
    this.mcpHub = new MCPHub(this.config, { watch: this.watch });

    // Set up capability change handlers before initialization
    this.mcpHub.on("toolsChanged", ({ server, tools }) => {
      broadcastCapabilityChange("TOOL", server, { tools });
    });

    this.mcpHub.on(
      "resourcesChanged",
      ({ server, resources, resourceTemplates }) => {
        broadcastCapabilityChange("RESOURCE", server, {
          resources,
          resourceTemplates,
        });
      }
    );

    await this.mcpHub.initialize();

    // Initialize client manager with shutdown delay
    clientManager = new ClientManager(this.shutdownDelay);

    // Initialize marketplace
    marketplace = getMarketplace();
    await marketplace.initialize();
  }

  async startServer() {
    return new Promise((resolve, reject) => {
      logger.info(`Starting HTTP server on port ${this.port}`, {
        port: this.port,
      });
      this.server = app.listen(this.port, () => {
        const serverStatuses = this.mcpHub.getAllServerStatuses();
        // Output structured startup JSON
        const startupInfo = {
          status: "ready",
          server_id: SERVER_ID,
          port: this.port,
          pid: process.pid,
          servers: serverStatuses,
          timestamp: new Date().toISOString(),
        };
        broadcastEvent("server_ready", startupInfo);
        logger.info(`MCP_HUB_STARTED`, {
          status: "ready",
          port: this.port,
        });
        resolve();
      });

      this.server.on("error", (error) => {
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

    logger.info("Stopping MCP Hub and disconnecting all servers");
    try {
      await this.mcpHub.disconnectAll();
      logger.info(
        "MCP Hub has been successfully stopped and all servers disconnected"
      );
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
    logger.info("Starting graceful shutdown process");

    // Notify all clients before shutdown
    broadcastEvent("server_shutdown", {
      server_id: SERVER_ID,
      reason: "shutdown",
      timestamp: new Date().toISOString(),
    });

    // Close all SSE connections
    sseClients.forEach((client) => client.end());
    sseClients.clear();

    await this.stopServer();
    await this.stopMCPHub();
  }
}

// Register SSE endpoint
registerRoute("GET", "/events", "Subscribe to server events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Send initial server info
  const serverInfo = {
    server_id: SERVER_ID,
    status: "connected",
    pid: process.pid,
    port: serviceManager?.port,
    activeClients: clientManager?.getActiveClientCount() || 0,
    timestamp: new Date().toISOString(),
  };
  res.write(`event: server_info\ndata: ${JSON.stringify(serverInfo)}\n\n`);

  // Add client to set
  sseClients.add(res);

  // Handle client disconnect
  req.on("close", () => {
    sseClients.delete(res);
  });
});

// Register marketplace endpoints
registerRoute(
  "GET",
  "/marketplace",
  "Get marketplace catalog with filtering and sorting",
  async (req, res) => {
    try {
      const { search, category, tags, sort } = req.query;
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
    try {
      const { mcpId } = req.body;
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

// Register client management routes
registerRoute(
  "POST",
  "/client/register",
  "Register a new client",
  (req, res) => {
    const { clientId } = req.body;
    if (!clientId) {
      throw new ValidationError("Missing client ID", { field: "clientId" });
    }

    const activeClients = clientManager.registerClient(clientId);

    // Notify all clients about new client
    broadcastEvent("client_registered", {
      activeClients,
      clientId,
      timestamp: new Date().toISOString(),
    });

    res.json({
      status: "success",
      server_id: SERVER_ID,
      activeClients,
      timestamp: new Date().toISOString(),
    });
  }
);

registerRoute(
  "POST",
  "/client/unregister",
  "Unregister a client",
  (req, res) => {
    const { clientId } = req.body;
    if (!clientId) {
      throw new ValidationError("Missing client ID", { field: "clientId" });
    }

    const activeClients = clientManager.unregisterClient(clientId);

    // Notify all clients about client removal
    broadcastEvent("client_unregistered", {
      activeClients,
      clientId,
      timestamp: new Date().toISOString(),
    });

    res.json({
      status: "success",
      activeClients,
      timestamp: new Date().toISOString(),
    });
  }
);

// Register server start endpoint
registerRoute(
  "POST",
  "/servers/:name/start",
  "Start a server",
  async (req, res) => {
    const { name } = req.params;
    try {
      const status = await serviceManager.mcpHub.startServer(name);

      broadcastStatusUpdate({
        action: "start",
        server: name,
        // status: status,
      });

      res.json({
        status: "ok",
        server: status,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "SERVER_START_ERROR", { server: name });
    }
  }
);

// Register server stop endpoint
registerRoute(
  "POST",
  "/servers/:name/stop",
  "Stop a server",
  async (req, res) => {
    const { name } = req.params;
    const { disable } = req.query;
    try {
      const status = await serviceManager.mcpHub.stopServer(
        name,
        disable === "true"
      );

      broadcastStatusUpdate({
        action: "stop",
        server: name,
        status: status,
        disabled: disable === "true",
      });

      res.json({
        status: "ok",
        server: status,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "SERVER_STOP_ERROR", { server: name });
    }
  }
);

// Register health check endpoint
registerRoute("GET", "/health", "Check server health", (req, res) => {
  res.json({
    status: "ok",
    server_id: SERVER_ID,
    activeClients: clientManager?.getActiveClientCount() || 0,
    timestamp: new Date().toISOString(),
    servers: serviceManager?.mcpHub?.getAllServerStatuses() || [],
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
  "GET",
  "/servers/:name/info",
  "Get status of a specific server",
  (req, res) => {
    const { name } = req.params;
    try {
      const status = serviceManager.mcpHub.getServerStatus(name);
      res.json({
        server: status,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "SERVER_NOT_FOUND", { server: name });
    }
  }
);

// Register server refresh endpoint
registerRoute(
  "GET",
  "/servers/:name/refresh",
  "Refresh a server's capabilities",
  async (req, res) => {
    const { name } = req.params;
    try {
      const info = await serviceManager.mcpHub.refreshServer(name);
      res.json({
        status: "ok",
        server: info,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "SERVER_REFRESH_ERROR", { server: name });
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

// Register tool execution endpoint
registerRoute(
  "POST",
  "/servers/:name/tools",
  "Execute a tool on a specific server",
  async (req, res) => {
    const { name } = req.params;
    const { tool, arguments: args } = req.body;

    if (!tool) {
      throw new ValidationError("Missing tool name", { field: "tool" });
    }

    try {
      const result = await serviceManager.mcpHub.callTool(
        name,
        tool,
        args || {}
      );
      res.json({
        result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, error.code || "TOOL_EXECUTION_ERROR", {
        server: name,
        tool,
        ...(error.data || {}),
      });
    }
  }
);

// Register resource access endpoint
registerRoute(
  "POST",
  "/servers/:name/resources",
  "Access a resource on a specific server",
  async (req, res) => {
    const { name } = req.params;
    const { uri } = req.body;

    if (!uri) {
      throw new ValidationError("Missing resource URI", { field: "uri" });
    }

    try {
      const result = await serviceManager.mcpHub.readResource(name, uri);
      res.json({
        result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, error.code || "RESOURCE_READ_ERROR", {
        server: name,
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
export async function startServer({
  port,
  config,
  watch = false,
  shutdownDelay = 0,
} = {}) {
  serviceManager = new ServiceManager(config, port, watch, shutdownDelay);

  try {
    serviceManager.setupSignalHandlers();
    await serviceManager.initializeMCPHub();
    await serviceManager.startServer();
  } catch (error) {
    const wrappedError =
      error.code === "EADDRINUSE"
        ? new ServerError("Port already in use", {
            port,
            error: error.message,
          })
        : wrapError(error, "SERVER_START_ERROR");

    logger.error(
      wrappedError.code,
      wrappedError.message,
      wrappedError.data,
      true,
      error.code === "EADDRINUSE" ? 0 : 1
    );

    await serviceManager.shutdown();
  }
}

export default app;
