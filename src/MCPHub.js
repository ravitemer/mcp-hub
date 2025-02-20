import logger from "./utils/logger.js";
import { ConfigManager } from "./utils/config.js";
import { MCPConnection } from "./MCPConnection.js";

export class MCPHub {
  constructor(configPathOrObject, { watch = false } = {}) {
    this.connections = new Map();
    this.configManager = new ConfigManager(configPathOrObject);
    this.shouldWatchConfig = watch && typeof configPathOrObject === "string";
  }

  async initialize() {
    await this.configManager.loadConfig();

    if (this.shouldWatchConfig) {
      this.configManager.watchConfig();
      this.configManager.on("configChanged", async (newConfig) => {
        await this.updateConfig(newConfig);
      });
    }

    await this.startConfiguredServers();
  }

  async startConfiguredServers() {
    const config = this.configManager.getConfig();
    const servers = Object.entries(config?.mcpServers || {});
    logger.info({
      message: "Starting configured servers",
      count: servers.length,
    });

    for (const [name, serverConfig] of servers) {
      try {
        // Skip disabled servers
        if (serverConfig.disabled) {
          logger.info({
            message: "Skipping disabled server",
            server: name,
          });
          continue;
        }

        logger.info({
          message: "Starting server",
          server: name,
        });
        await this.connectServer(name, serverConfig);
      } catch (error) {
        logger.error({
          message: "Failed to start server",
          server: name,
          error: error.message,
        });
      }
    }
  }

  async updateConfig(newConfigOrPath) {
    await this.configManager.updateConfig(newConfigOrPath);
    await this.startConfiguredServers();
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
      logger.error({
        message: "Failed to connect server",
        server: name,
        error: error.message,
      });
      return connection.getServerInfo();
    }
  }

  async disconnectServer(name) {
    const connection = this.connections.get(name);
    if (connection) {
      try {
        await connection.disconnect();
      } catch (error) {
        logger.error({
          message: "Error disconnecting server",
          server: name,
          error: error.message,
        });
      } finally {
        this.connections.delete(name);
      }
    }
  }

  async disconnectAll() {
    logger.info({
      message: "Disconnecting all servers",
      count: this.connections.size,
    });

    const results = await Promise.allSettled(
      Array.from(this.connections.keys()).map((name) =>
        this.disconnectServer(name)
      )
    );

    // Log any failures
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const name = Array.from(this.connections.keys())[index];
        logger.error({
          message: "Failed to disconnect server during cleanup",
          server: name,
          error: result.reason.message,
        });
      }
    });

    // Ensure connections map is cleared even if some disconnections failed
    this.connections.clear();
  }

  getServerStatus(name) {
    return this.connections.get(name)?.getServerInfo();
  }

  getAllServerStatuses() {
    return Array.from(this.connections.values()).map((connection) =>
      connection.getServerInfo()
    );
  }

  async callTool(serverName, toolName, args) {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`Server "${serverName}" not found`);
    }
    return await connection.callTool(toolName, args);
  }

  async readResource(serverName, uri) {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`Server "${serverName}" not found`);
    }
    return await connection.readResource(uri);
  }
}

export { MCPConnection } from "./MCPConnection.js";
