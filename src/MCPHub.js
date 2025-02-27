import logger from "./utils/logger.js";
import { ConfigManager } from "./utils/config.js";
import { MCPConnection } from "./MCPConnection.js";
import {
  ServerError,
  ConnectionError,
  ConfigError,
  wrapError,
} from "./utils/errors.js";

export class MCPHub {
  constructor(configPathOrObject, { watch = false } = {}) {
    this.connections = new Map();
    this.configManager = new ConfigManager(configPathOrObject);
    this.shouldWatchConfig = watch && typeof configPathOrObject === "string";
  }

  async initialize() {
    try {
      await this.configManager.loadConfig();

      if (this.shouldWatchConfig) {
        this.configManager.watchConfig();
        this.configManager.on("configChanged", async (newConfig) => {
          await this.updateConfig(newConfig);
        });
      }

      await this.startConfiguredServers();
    } catch (error) {
      // Only wrap if it's not already our error type
      if (!(error instanceof ConfigError)) {
        throw wrapError(error, "HUB_INIT_ERROR", {
          watchEnabled: this.shouldWatchConfig,
        });
      }
      throw error;
    }
  }

  async startConfiguredServers() {
    const config = this.configManager.getConfig();
    const servers = Object.entries(config?.mcpServers || {});
    logger.info(`Starting ${servers.length} configured MCP servers`, {
      count: servers.length,
    });

    for (const [name, serverConfig] of servers) {
      try {
        // Skip disabled servers
        if (serverConfig.disabled) {
          logger.info(`Skipping disabled server '${name}'`, { server: name });
          continue;
        }

        logger.info(`Starting MCP server '${name}'`, { server: name });
        await this.connectServer(name, serverConfig);
      } catch (error) {
        // Don't throw here as we want to continue with other servers
        logger.error(
          error.code || "SERVER_START_ERROR",
          "Failed to start server",
          {
            server: name,
            error: error.message,
          },
          false
        );
      }
    }
  }

  async updateConfig(newConfigOrPath) {
    try {
      await this.configManager.updateConfig(newConfigOrPath);
      await this.startConfiguredServers();
    } catch (error) {
      throw wrapError(error, "CONFIG_UPDATE_ERROR", {
        isPathUpdate: typeof newConfigOrPath === "string",
      });
    }
  }

  async connectServer(name, config) {
    // Disconnect existing connection if any
    await this.disconnectServer(name);

    const connection = new MCPConnection(name, config);
    this.connections.set(name, connection);

    try {
      await connection.connect();
      return connection.getServerInfo();
    } catch (error) {
      // Connection errors are already properly typed from MCPConnection
      if (!(error instanceof ConnectionError)) {
        throw new ServerError(`Failed to connect server "${name}"`, {
          server: name,
          error: error.message,
        });
      }
      throw error;
    }
  }

  async disconnectServer(name) {
    const connection = this.connections.get(name);
    if (connection) {
      try {
        await connection.disconnect();
      } catch (error) {
        // Log but don't throw since we're cleaning up
        logger.error(
          "SERVER_DISCONNECT_ERROR",
          "Error disconnecting server",
          {
            server: name,
            error: error.message,
          },
          false
        );
      } finally {
        this.connections.delete(name);
      }
    }
  }

  async disconnectAll() {
    logger.info(
      `Disconnecting all servers (${this.connections.size} active connections)`,
      {
        count: this.connections.size,
      }
    );

    const results = await Promise.allSettled(
      Array.from(this.connections.keys()).map((name) =>
        this.disconnectServer(name)
      )
    );

    // Log any failures
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const name = Array.from(this.connections.keys())[index];
        logger.error(
          "SERVER_DISCONNECT_ERROR",
          "Failed to disconnect server during cleanup",
          {
            server: name,
            error: result.reason?.message || "Unknown error",
          },
          false
        );
      }
    });

    // Ensure connections map is cleared even if some disconnections failed
    this.connections.clear();
  }

  getServerStatus(name) {
    const connection = this.connections.get(name);
    if (!connection) {
      throw new ServerError("Server not found", { server: name });
    }
    return connection.getServerInfo();
  }

  getAllServerStatuses() {
    return Array.from(this.connections.values()).map((connection) =>
      connection.getServerInfo()
    );
  }

  async callTool(serverName, toolName, args) {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new ServerError("Server not found", {
        server: serverName,
        operation: "tool_call",
        tool: toolName,
      });
    }
    return await connection.callTool(toolName, args);
  }

  async readResource(serverName, uri) {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new ServerError("Server not found", {
        server: serverName,
        operation: "resource_read",
        uri,
      });
    }
    return await connection.readResource(uri);
  }
}

export { MCPConnection } from "./MCPConnection.js";
