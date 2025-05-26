import chokidar from "chokidar";
import { EventEmitter } from "events";
import logger from "./logger.js";
import path from "path";

export class DevWatcher extends EventEmitter {
  constructor(serverName, devConfig) {
    super();
    this.serverName = serverName;
    this.devConfig = this.#normalizeConfig(devConfig);
    this.watcher = null;
    this.debounceTimer = null;
    this.isWatching = false;
    this.changedFiles = new Set(); // Track files that changed during debounce
  }

  #normalizeConfig(devConfig) {
    return {
      enabled: devConfig.enabled ?? true,
      watch: devConfig.watch ?? ["**/*.js", "**/*.ts", "**/*.py", "**/*.json"],
      cwd: devConfig.cwd, // Required field from config
      debounce: 500, // Fixed 500ms debounce
    };
  }

  #shouldEnableDevMode() {
    return this.devConfig.enabled === true;
  }

  async start(config) {
    if (config) {
      this.devConfig = config
    }
    if (!this.#shouldEnableDevMode()) {
      return;
    }

    if (this.isWatching) {
      return;
    }

    try {
      const watchingDir = this.devConfig.cwd;

      logger.info(`Starting dev watcher for server '${this.serverName}' in ${watchingDir}`);

      // Use Node.js glob function to resolve patterns to actual files (chokidar v4 approach)
      const { glob } = await import('node:fs/promises');
      const allFiles = [];

      // Resolve each pattern to actual files
      for (const pattern of this.devConfig.watch) {
        const resolvedFiles = await Array.fromAsync(glob(pattern, { cwd: watchingDir }));
        const absoluteFiles = resolvedFiles.map(file => path.join(watchingDir, file));
        allFiles.push(...absoluteFiles);
      }

      logger.info(`Dev watcher watching ${allFiles.length} files for '${this.serverName}'`);

      this.watcher = chokidar.watch(allFiles, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 100,
          pollInterval: 50
        },
      });
      // Handle file changes with debouncing
      this.watcher.on('change', (filePath) => this.#handleFileChange(filePath, 'change'));
      this.watcher.on('add', (filePath) => this.#handleFileChange(filePath, 'add'));
      this.watcher.on('unlink', (filePath) => this.#handleFileChange(filePath, 'unlink'));
      // Handle watcher errors
      this.watcher.on('error', (error) => {
        logger.error('DEV_WATCHER_ERROR', `Dev watcher error for '${this.serverName}': ${error.message}`, {}, false);
      });

      this.isWatching = true;
      logger.info(`Dev watcher started for server '${this.serverName}'`);
    } catch (error) {
      logger.error('DEV_WATCHER_START_ERROR', `Failed to start dev watcher for '${this.serverName}': ${error.message}`, {}, false);
      throw error;
    }
  }

  #handleFileChange(filePath, eventType) {
    // Add file to changed files set
    this.changedFiles.add(filePath);

    // Clear existing debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Set new debounce timer
    this.debounceTimer = setTimeout(() => {
      const changedFilesArray = Array.from(this.changedFiles);
      const watchingDir = this.devConfig.cwd;

      // Files from chokidar are relative to the watching directory
      const relativeFiles = changedFilesArray.map(file => {
        if (path.isAbsolute(file)) {
          return path.relative(watchingDir, file);
        }
        return file;
      });

      logger.info(`File changes detected for server '${this.serverName}': ${relativeFiles.join(', ')}`);

      // Emit restart event
      this.emit('filesChanged', {
        serverName: this.serverName,
        files: changedFilesArray,
        relativeFiles: relativeFiles,
        watchingDir: watchingDir,
        timestamp: new Date().toISOString(),
      });
      // Clear the changed files set
      this.changedFiles.clear();
    }, this.devConfig.debounce);
  }

  async stop() {
    if (!this.isWatching) {
      return;
    }

    // Clear debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // Clear changed files
    this.changedFiles.clear();

    // Close watcher
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    this.isWatching = false;
    logger.info(`Dev watcher stopped for server '${this.serverName}'`);
  }

  getStatus() {
    return {
      enabled: this.#shouldEnableDevMode(),
      isWatching: this.isWatching,
      config: this.devConfig,
      watchingDir: this.devConfig.cwd,
    };
  }
}
