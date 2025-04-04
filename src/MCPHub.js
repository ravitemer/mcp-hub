import logger from "./utils/logger.js";
import { ConfigManager } from "./utils/config.js";
import { MCPConnection } from "./MCPConnection.js";
import {
  ServerError,
  ConnectionError,
  ConfigError,
  wrapError,
} from "./utils/errors.js";
import EventEmitter from "events";

export class MCPHub extends EventEmitter {
  constructor(configPathOrObject, { watch = false, marketplace } = {}) {
    super();
    this.connections = new Map();
    this.configManager = new ConfigManager(configPathOrObject);
    this.shouldWatchConfig = watch && typeof configPathOrObject === "string";
    this.marketplace = marketplace;
  }
  async initialize(isRestarting) {
    try {
      await this.configManager.loadConfig();

      if (this.shouldWatchConfig && !isRestarting) {
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
    await this.disconnectAll();

    logger.info(
      `Starting ${servers.length} configured MCP servers in parallel`,
      {
        count: servers.length,
      }
    );
    // Create and connect servers in parallel
    const startPromises = servers.map(async ([name, serverConfig]) => {
      try {
        if (serverConfig.disabled === true) {
          logger.debug(`Skipping disabled MCP server '${name}'`, {
            server: name,
          });
        } else {
          logger.info(`Initializing MCP server '${name}'`, { server: name });
        }

        const connection = new MCPConnection(
          name,
          serverConfig,
          this.marketplace
        );

        // Forward events from connection
        connection.on("toolsChanged", (data) =>
          this.emit("toolsChanged", data)
        );
        connection.on("resourcesChanged", (data) =>
          this.emit("resourcesChanged", data)
        );
        connection.on("promptsChanged", (data) =>
          this.emit("promptsChanged", data)
        );
        connection.on("notification", (data) =>
          this.emit("notification", data)
        );

        this.connections.set(name, connection);
        await connection.connect();

        return {
          name,
          status: "success",
          config: serverConfig,
        };
      } catch (error) {
        const e = wrapError(error);
        logger.error(e.code || "SERVER_START_ERROR", e.message, e.data, false);

        return {
          name,
          status: "error",
          error: error.message,
          config: serverConfig,
        };
      }
    });

    // Wait for all servers to start and log summary
    const results = await Promise.all(startPromises);

    const successful = results.filter((r) => r.status === "success");
    const failed = results.filter((r) => r.status === "error");
    const disabled = results.filter((r) => r.config.disabled === true);

    logger.info(`${successful.length}/${servers.length} servers started successfully`, {
      total: servers.length,
      successful: successful.length,
      failed: failed.length,
      disabled: disabled.length,
      failedServers: failed.map((f) => f.name),
    });
  }

  async startServer(name) {
    const config = this.configManager.getConfig();
    const serverConfig = config.mcpServers?.[name];
    if (!serverConfig) {
      throw new ServerError("Server not found", { server: name });
    }

    const connection = this.connections.get(name);
    if (!connection) {
      throw new ServerError("Server connection not found", { server: name });
    }

    // If server was disabled, update config
    if (serverConfig.disabled) {
      serverConfig.disabled = false;
      await this.configManager.updateConfig(config);
    }

    return await connection.start();
  }

  async stopServer(name, disable = false) {
    const config = this.configManager.getConfig();
    const serverConfig = config.mcpServers?.[name];
    if (!serverConfig) {
      throw new ServerError("Server not found", { server: name });
    }

    // If disabling, update config
    if (disable) {
      serverConfig.disabled = true;
      await this.configManager.updateConfig(config);
    }

    const connection = this.connections.get(name);
    if (!connection) {
      throw new ServerError("Server connection not found", { server: name });
    }
    connection.removeAllListeners();
    return await connection.stop(disable);
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
    const connection = new MCPConnection(name, config, this.marketplace);
    this.connections.set(name, connection);
    await connection.connect();
    return connection.getServerInfo();
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
      }
      // Don't remove from connections map
    }
  }

  async disconnectAll() {
    const serverNames = Array.from(this.connections.keys());
    logger.info(`Disconnecting all servers in parallel`, {
      count: serverNames.length,
    });

    const results = await Promise.allSettled(
      serverNames.map((name) => this.disconnectServer(name))
    );

    const successful = results.filter((r) => r.status === "fulfilled");
    const failed = results
      .filter((r) => r.status === "rejected")
      .map((r, i) => ({
        name: serverNames[i],
        error: r.reason?.message || "Unknown error",
      }));

    // Log failures
    failed.forEach(({ name, error }) => {
      logger.error(
        "SERVER_DISCONNECT_ERROR",
        "Failed to disconnect server during cleanup",
        {
          server: name,
          error,
        },
        false
      );
    });

    if (serverNames.length) {
      logger.info(`${successful.length} servers disconnected`, {
        total: serverNames.length,
        successful: successful.length,
        failed: failed.length,
        failedServers: failed.map((f) => f.name),
      });
    }
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

  async getPrompt(serverName, promtName, args) {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new ServerError("Server not found", {
        server: serverName,
        operation: "get_prompt",
        prompt: promtName,
      });
    }
    return await connection.getPrompt(promtName, args);
  }

  async refreshServer(name) {
    const connection = this.connections.get(name);
    if (!connection) {
      throw new ServerError("Server not found", { server: name });
    }

    logger.info(`Refreshing capabilities for server '${name}'`);
    await connection.updateCapabilities();
    return connection.getServerInfo();
  }

  async refreshAllServers() {
    logger.info("Refreshing capabilities for all servers");
    const serverNames = Array.from(this.connections.keys());

    const results = await Promise.allSettled(
      serverNames.map(async (name) => {
        try {
          const connection = this.connections.get(name);
          await connection.updateCapabilities();
          return connection.getServerInfo();
        } catch (error) {
          logger.error(
            "CAPABILITIES_REFRESH_ERROR",
            `Failed to refresh capabilities for server ${name}`,
            {
              server: name,
              error: error.message,
            },
            false
          );
          return {
            name,
            status: "error",
            error: error.message,
          };
        }
      })
    );

    return results.map((result) =>
      result.status === "fulfilled" ? result.value : result.reason
    );
  }
}

export { MCPConnection } from "./MCPConnection.js";
