import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ConfigManager } from "../src/utils/config.js";
import fs from "fs/promises";
import * as fsSync from "fs";
import { EventEmitter } from "events";

// Mock fs.watch
vi.mock("fs", async () => {
  const actual = await vi.importActual("fs");
  return {
    ...actual,
    watch: vi.fn(() => {
      const watcher = new EventEmitter();
      watcher.close = vi.fn();
      return watcher;
    }),
  };
});

// Mock logger
vi.mock("../src/utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe("ConfigManager", () => {
  let configManager;
  const validConfig = {
    mcpServers: {
      test: {
        command: "node",
        args: ["server.js"],
        env: { PORT: "3000" },
      },
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    if (configManager) {
      configManager.stopWatching();
    }
  });

  describe("constructor", () => {
    it("should initialize with config object", () => {
      configManager = new ConfigManager(validConfig);
      expect(configManager.getConfig()).toEqual(validConfig);
    });

    it("should initialize with config path", () => {
      configManager = new ConfigManager("/path/to/config.json");
      expect(configManager.configPath).toBe("/path/to/config.json");
    });
  });

  describe("loadConfig", () => {
    it("should load and validate config from file", async () => {
      vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify(validConfig));

      configManager = new ConfigManager("/path/to/config.json");
      await configManager.loadConfig();

      expect(configManager.getConfig()).toEqual(validConfig);
      expect(fs.readFile).toHaveBeenCalledWith("/path/to/config.json", "utf-8");
    });

    it("should throw error if no config path specified", async () => {
      configManager = new ConfigManager();
      await expect(configManager.loadConfig()).rejects.toThrow(
        "No config path specified"
      );
    });

    it("should throw error for invalid config structure", async () => {
      vi.spyOn(fs, "readFile").mockResolvedValue(
        JSON.stringify({ invalid: "config" })
      );

      configManager = new ConfigManager("/path/to/config.json");
      await expect(configManager.loadConfig()).rejects.toThrow(
        "Invalid config: missing or invalid 'mcpServers' object"
      );
    });

    it("should throw error for server missing command", async () => {
      const invalidConfig = {
        mcpServers: {
          test: {
            args: [],
          },
        },
      };
      vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify(invalidConfig));

      configManager = new ConfigManager("/path/to/config.json");
      await expect(configManager.loadConfig()).rejects.toThrow(
        "Invalid config: server 'test' missing 'command'"
      );
    });

    it("should set default empty array for missing args", async () => {
      const configWithoutArgs = {
        mcpServers: {
          test: {
            command: "node",
          },
        },
      };
      vi.spyOn(fs, "readFile").mockResolvedValue(
        JSON.stringify(configWithoutArgs)
      );

      configManager = new ConfigManager("/path/to/config.json");
      await configManager.loadConfig();

      expect(configManager.getServerConfig("test").args).toEqual([]);
    });

    it("should throw error for invalid env", async () => {
      const invalidConfig = {
        mcpServers: {
          test: {
            command: "node",
            env: "invalid",
          },
        },
      };
      vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify(invalidConfig));

      configManager = new ConfigManager("/path/to/config.json");
      await expect(configManager.loadConfig()).rejects.toThrow(
        "Invalid config: server 'test' has invalid 'env'"
      );
    });
  });

  describe("watchConfig", () => {
    it("should start watching config file", () => {
      configManager = new ConfigManager("/path/to/config.json");
      configManager.watchConfig();

      expect(fsSync.watch).toHaveBeenCalledWith(
        "/path/to/config.json",
        expect.any(Function)
      );
    });

    it("should not create multiple watchers", () => {
      configManager = new ConfigManager("/path/to/config.json");
      configManager.watchConfig();
      configManager.watchConfig();

      expect(fsSync.watch).toHaveBeenCalledTimes(1);
    });

    it("should handle watch errors", () => {
      configManager = new ConfigManager("/path/to/config.json");
      configManager.watchConfig();

      const watcher = fsSync.watch.mock.results[0].value;
      const error = new Error("Watch error");

      watcher.emit("error", error);
    });
  });

  describe("updateConfig", () => {
    it("should update config with new path", async () => {
      vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify(validConfig));

      configManager = new ConfigManager("/path/to/config.json");
      await configManager.updateConfig("/path/to/new-config.json");

      expect(configManager.configPath).toBe("/path/to/new-config.json");
      expect(configManager.getConfig()).toEqual(validConfig);
    });
  });

  describe("getServerConfig", () => {
    it("should return specific server config", () => {
      configManager = new ConfigManager(validConfig);
      expect(configManager.getServerConfig("test")).toEqual(
        validConfig.mcpServers.test
      );
    });

    it("should return undefined for non-existent server", () => {
      configManager = new ConfigManager(validConfig);
      expect(configManager.getServerConfig("non-existent")).toBeUndefined();
    });
  });

  describe("stopWatching", () => {
    it("should close watcher if exists", () => {
      configManager = new ConfigManager("/path/to/config.json");
      configManager.watchConfig();

      const watcher = fsSync.watch.mock.results[0].value;
      configManager.stopWatching();

      expect(watcher.close).toHaveBeenCalled();
      expect(configManager.watcher).toBeNull();
    });

    it("should do nothing if no watcher exists", () => {
      configManager = new ConfigManager("/path/to/config.json");
      configManager.stopWatching();
    });
  });
});
