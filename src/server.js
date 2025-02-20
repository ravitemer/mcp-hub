import express from "express";
import logger from "./utils/logger.js";
import { MCPHub } from "./MCPHub.js";
import { ClientManager } from "./utils/client-manager.js";
import {
  router,
  registerRoute,
  generateStartupMessage,
} from "./utils/router.js";

const VERSION = "1.0.0";
const SERVER_ID = "mcp-hub";

// Create Express app
const app = express();
app.use(express.json());
app.use("/api", router);

// SSE client set
const sseClients = new Set();

// Send event to all SSE clients
function broadcastEvent(event, data) {
  sseClients.forEach((client) => {
    client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });
}

let serviceManager = null;
let clientManager = null;

class ServiceManager {
  constructor(config, port, watch = false) {
    this.config = config;
    this.port = port;
    this.watch = watch;
    this.mcpHub = null;
    this.server = null;
  }

  async initializeMCPHub() {
    logger.info({ message: "Initializing MCP Hub" });
    this.mcpHub = new MCPHub(this.config, { watch: this.watch });
    await this.mcpHub.initialize();

    // Initialize client manager
    clientManager = new ClientManager();
  }

  async startServer() {
    return new Promise((resolve, reject) => {
      logger.info({ message: `Starting HTTP server on port ${this.port}` });
      this.server = app.listen(this.port, () => {
        const serverStatuses = this.mcpHub.getAllServerStatuses();
        // Output structured startup JSON
        const startupInfo = {
          status: "ready",
          server_id: SERVER_ID,
          version: VERSION,
          port: this.port,
          pid: process.pid,
          servers: serverStatuses,
          timestamp: new Date().toISOString(),
        };
        // console.log(JSON.stringify(startupInfo));
        broadcastEvent("server_ready", startupInfo);
        logger.info({
          status: "ready",
          message: "MCP Hub server started",
          port: this.port,
        });
        resolve();
      });

      this.server.on("error", (error) => {
        reject(error);
      });
    });
  }

  async stopServer() {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        logger.warn({ message: "HTTP server already stopped" });
        resolve();
        return;
      }

      logger.info({ message: "Stopping HTTP server" });
      this.server.close((error) => {
        if (error) {
          logger.error({
            message: "Failed to stop HTTP server",
            error: error.message,
            stack: error.stack,
          });
          reject(error);
          return;
        }

        logger.info({ message: "HTTP server stopped" });
        this.server = null;
        resolve();
      });
    });
  }

  async stopMCPHub() {
    if (!this.mcpHub) {
      logger.warn({ message: "MCP Hub already stopped" });
      return;
    }

    logger.info({ message: "Stopping MCP Hub" });
    try {
      await this.mcpHub.disconnectAll();
      logger.info({ message: "MCP Hub stopped" });
      this.mcpHub = null;
    } catch (error) {
      logger.error({
        message: "Failed to stop MCP Hub",
        error: error.message,
        stack: error.stack,
      });
    }
  }

  setupSignalHandlers() {
    const shutdown = async (signal) => {
      logger.info({ message: `Received signal: ${signal}` });
      try {
        await this.shutdown();
        logger.info({ message: "Shutdown complete" });
        process.exit(0);
      } catch (error) {
        logger.error({
          message: "Shutdown failed",
          error: error.message,
          stack: error.stack,
        });
        process.exit(1);
      }
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  }

  async shutdown() {
    logger.info({ message: "Shutting down" });

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
    version: VERSION,
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

// Register client management routes
registerRoute(
  "POST",
  "/client/register",
  "Register a new client",
  (req, res) => {
    const { clientId } = req.body;
    if (!clientId) {
      return res.status(400).json({
        error: "Missing required field: clientId",
        timestamp: new Date().toISOString(),
      });
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
      version: VERSION,
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
      return res.status(400).json({
        error: "Missing required field: clientId",
        timestamp: new Date().toISOString(),
      });
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

// Register health check endpoint
registerRoute("GET", "/health", "Check server health", (req, res) => {
  res.json({
    status: "ok",
    server_id: SERVER_ID,
    version: VERSION,
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
    const name = req.params.name;
    const status = serviceManager.mcpHub.getServerStatus(name);

    if (!status) {
      return res.status(404).json({
        error: `Server '${name}' not found`,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      server: status,
      timestamp: new Date().toISOString(),
    });
  }
);

// Register tool execution endpoint
registerRoute(
  "POST",
  "/servers/:name/tools",
  "Execute a tool on a specific server",
  async (req, res, next) => {
    const { name } = req.params;
    const { tool, arguments: args } = req.body;

    if (!tool) {
      return res.status(400).json({
        error: "Missing required field: tool",
        timestamp: new Date().toISOString(),
      });
    }

    const status = serviceManager.mcpHub.getServerStatus(name);

    if (!status) {
      return res.status(404).json({
        error: `Server '${name}' not found`,
        timestamp: new Date().toISOString(),
      });
    }

    if (status.status !== "connected") {
      return res.status(400).json({
        error: `Server '${name}' is not connected (status: ${status.status})`,
        timestamp: new Date().toISOString(),
      });
    }

    if (!status.tools.find((t) => t.name === tool)) {
      return res.status(404).json({
        error: `Tool '${tool}' not found on server '${name}'`,
        timestamp: new Date().toISOString(),
      });
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
      next(error);
    }
  }
);

// Register resource access endpoint
registerRoute(
  "POST",
  "/servers/:name/resources",
  "Access a resource on a specific server",
  async (req, res, next) => {
    const { name } = req.params;
    const { uri } = req.body;

    if (!uri) {
      return res.status(400).json({
        error: "Missing required field: uri",
        timestamp: new Date().toISOString(),
      });
    }

    const status = serviceManager.mcpHub.getServerStatus(name);

    if (!status) {
      return res.status(404).json({
        error: `Server '${name}' not found`,
        timestamp: new Date().toISOString(),
      });
    }

    if (status.status !== "connected") {
      return res.status(400).json({
        error: `Server '${name}' is not connected (status: ${status.status})`,
        timestamp: new Date().toISOString(),
      });
    }

    try {
      const result = await serviceManager.mcpHub.readResource(name, uri);
      res.json({
        result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  }
);

// Error handler middleware
router.use((err, req, res, next) => {
  logger.error({
    message: "Request error",
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  // Only send error response if headers haven't been sent
  if (!res.headersSent) {
    res.status(500).json({
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Start the server with options
export async function startServer({ port, config, watch = false } = {}) {
  serviceManager = new ServiceManager(config, port, watch);

  try {
    await serviceManager.initializeMCPHub();
    await serviceManager.startServer();
    serviceManager.setupSignalHandlers();
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      logger.error({
        message: "Port already in use",
        port: port,
        error: error.message,
        stack: error.stack,
      });
      console.error(
        `❌ Port ${port} is already in use. Please specify a different port or kill the process using port ${port}.`
      );
      serviceManager.server = null;
    } else {
      logger.error({
        message: "Failed to start server",
        error: error.message,
        stack: error.stack,
      });
    }
    await serviceManager.shutdown();
    process.exit(1);
  }
}

export default app;
