import fs from "fs/promises";
import { watch } from "fs";
import { EventEmitter } from "events";
import logger from "./logger.js";

export class ConfigManager extends EventEmitter {
  constructor(configPathOrObject) {
    super();
    this.configPath = null;
    this.config = null;
    this.watcher = null;

    if (typeof configPathOrObject === "string") {
      this.configPath = configPathOrObject;
    } else if (configPathOrObject && typeof configPathOrObject === "object") {
      this.config = configPathOrObject;
    }
  }

  async updateConfig(newConfigOrPath) {
    if (typeof newConfigOrPath === "string") {
      // Update config path and reload
      this.configPath = newConfigOrPath;
      await this.loadConfig();
    } else if (newConfigOrPath && typeof newConfigOrPath === "object") {
      // Update config directly
      this.config = newConfigOrPath;
    }
  }

  async loadConfig() {
    if (!this.configPath) {
      throw new Error("No config path specified");
    }

    try {
      const content = await fs.readFile(this.configPath, "utf-8");
      const newConfig = JSON.parse(content);

      // Validate config structure
      if (!newConfig.mcpServers || typeof newConfig.mcpServers !== "object") {
        throw new Error(
          "Invalid config: missing or invalid 'mcpServers' object"
        );
      }

      // Validate each server configuration
      for (const [name, server] of Object.entries(newConfig.mcpServers)) {
        if (!server.command) {
          throw new Error(`Invalid config: server '${name}' missing 'command'`);
        }
        if (!Array.isArray(server.args)) {
          server.args = []; // Default to empty array if not provided
        }
        if (server.env && typeof server.env !== "object") {
          throw new Error(`Invalid config: server '${name}' has invalid 'env'`);
        }
      }

      this.config = newConfig;
      logger.info({
        message: "Config loaded successfully",
        path: this.configPath,
        serverCount: Object.keys(newConfig.mcpServers).length,
      });

      return this.config;
    } catch (error) {
      logger.error({
        message: "Failed to load config",
        path: this.configPath,
        error: error.message,
      });
      throw error;
    }
  }

  watchConfig() {
    if (this.watcher) {
      return;
    }

    try {
      this.watcher = watch(this.configPath, async (eventType) => {
        if (eventType === "change") {
          logger.info({
            message: "Config file changed, reloading",
            path: this.configPath,
          });

          try {
            const newConfig = await this.loadConfig();
            this.emit("configChanged", newConfig);
          } catch (error) {
            logger.error({
              message: "Error reloading config after change",
              error: error.message,
            });
          }
        }
      });

      // Handle watcher errors
      this.watcher.on("error", (error) => {
        logger.error({
          message: "Config watcher error",
          error: error.message,
        });
      });

      logger.info({
        message: "Started watching config file",
        path: this.configPath,
      });
    } catch (error) {
      logger.error({
        message: "Failed to start config watcher",
        error: error.message,
      });
      throw error;
    }
  }

  stopWatching() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      logger.info({
        message: "Stopped watching config file",
        path: this.configPath,
      });
    }
  }

  getConfig() {
    return this.config;
  }

  getServerConfig(serverName) {
    return this.config?.mcpServers?.[serverName];
  }
}
