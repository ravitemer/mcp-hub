import fs from "fs/promises";
import { watch } from "fs";
import { EventEmitter } from "events";
import logger from "./logger.js";
import { ConfigError, wrapError } from "./errors.js";

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
      throw new ConfigError("No config path specified");
    }

    try {
      const content = await fs.readFile(this.configPath, "utf-8");
      const newConfig = JSON.parse(content);

      // Validate config structure
      if (!newConfig.mcpServers || typeof newConfig.mcpServers !== "object") {
        throw new ConfigError("Missing or invalid mcpServers configuration", {
          config: newConfig,
        });
      }

      // Validate each server configuration
      for (const [name, server] of Object.entries(newConfig.mcpServers)) {
        if (!server.command) {
          throw new ConfigError(`Server '${name}' missing command`, {
            server: name,
            config: server,
          });
        }
        if (!Array.isArray(server.args)) {
          server.args = []; // Default to empty array if not provided
        }
        if (server.env && typeof server.env !== "object") {
          throw new ConfigError(
            `Server '${name}' has invalid environment config`,
            {
              server: name,
              env: server.env,
            }
          );
        }
      }

      this.config = newConfig;
      logger.info(`Config loaded successfully from ${this.configPath}`, {
        path: this.configPath,
        serverCount: Object.keys(newConfig.mcpServers).length,
      });

      return this.config;
    } catch (error) {
      if (error instanceof ConfigError) {
        throw error; // Re-throw our custom errors
      }
      if (error.code === "ENOENT") {
        throw new ConfigError("Config file not found", {
          path: this.configPath,
        });
      }
      if (error instanceof SyntaxError) {
        throw new ConfigError("Invalid JSON in config file", {
          path: this.configPath,
          parseError: error.message,
        });
      }
      // Wrap any other errors
      throw wrapError(error, "CONFIG_READ_ERROR", {
        path: this.configPath,
      });
    }
  }

  watchConfig() {
    if (this.watcher) {
      return;
    }

    try {
      this.watcher = watch(this.configPath, async (eventType) => {
        if (eventType === "change") {
          logger.info(`Config file at ${this.configPath} changed, reloading`, {
            path: this.configPath,
          });

          try {
            const newConfig = await this.loadConfig();
            this.emit("configChanged", newConfig);
          } catch (error) {
            // Don't throw here as this is an async event handler
            logger.error(
              error.code || "CONFIG_RELOAD_ERROR",
              "Error reloading config after change",
              error instanceof ConfigError
                ? error.data
                : { error: error.message },
              false
            );
          }
        }
      });

      // Handle watcher errors
      this.watcher.on("error", (error) => {
        logger.error(
          "CONFIG_WATCH_ERROR",
          "Config watcher error",
          { error: error.message },
          false
        );
      });

      logger.info(`Started watching config file at ${this.configPath}`, {
        path: this.configPath,
      });
    } catch (error) {
      throw new ConfigError("Failed to start config watcher", {
        path: this.configPath,
        error: error.message,
      });
    }
  }

  stopWatching() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      logger.info(`Stopped watching config file at ${this.configPath}`, {
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
