import fs from 'fs/promises';
import path from 'path';
import { getXDGDirectory } from './xdg-paths.js';
import logger from './logger.js';
import chokidar from 'chokidar';
import { EventEmitter } from 'events';

/**
 * Manages the global workspace cache file that tracks active mcp-hub instances
 * across all workspaces on the system.
 */
export class WorkspaceCacheManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.cacheFilePath = path.join(getXDGDirectory('state'), 'workspaces.json');
    this.lockFilePath = this.cacheFilePath + '.lock';
    this.watcher = null;
    this.isWatching = false;
    this.port = options.port || null;
  }

  /**
   * Get the current workspace key (port as string)
   */
  getWorkspaceKey() {
    return this.port ? this.port.toString() : null;
  }

  /**
   * Initialize the cache manager and start watching for changes
   */
  async initialize() {
    try {
      // Ensure the state directory exists
      const stateDir = path.dirname(this.cacheFilePath);
      await fs.mkdir(stateDir, { recursive: true });

      // Ensure the cache file exists
      await this._ensureCacheFile();

      logger.debug('WorkspaceCacheManager initialized', {
        cacheFile: this.cacheFilePath,
        workspaceKey: this.getWorkspaceKey()
      });
    } catch (error) {
      logger.error('WORKSPACE_CACHE_INIT_ERROR', `Failed to initialize workspace cache: ${error.message}`, {
        cacheFile: this.cacheFilePath,
        error: error.message
      }, false);
      throw error;
    }
  }

  /**
   * Register this hub instance in the workspace cache
   */
  async register(port, configFiles = []) {
    // Update our port reference
    this.port = port;
    const workspaceKey = this.getWorkspaceKey();

    if (!workspaceKey) {
      throw new Error('Cannot register workspace: no port specified');
    }

    const entry = {
      cwd: process.cwd(),
      config_files: configFiles,
      pid: process.pid,
      port: this.port,
      startTime: new Date().toISOString()
    };

    try {
      await this._withLock(async () => {
        const cache = await this._readCache();
        cache[workspaceKey] = entry;
        await this._writeCache(cache);
      });

      logger.info(`Registered workspace on port ${port}`, {
        port,
        cwd: entry.cwd,
        pid: entry.pid,
        config_files: configFiles.length
      });
    } catch (error) {
      logger.error('WORKSPACE_CACHE_REGISTER_ERROR', `Failed to register workspace: ${error.message}`, {
        port,
        error: error.message
      }, false);
      throw error;
    }
  }

  /**
   * Deregister this hub instance from the workspace cache
   */
  async deregister() {
    const workspaceKey = this.getWorkspaceKey();

    if (!workspaceKey) {
      logger.debug('No workspace key available for deregistration');
      return;
    }

    try {
      await this._withLock(async () => {
        const cache = await this._readCache();
        if (cache[workspaceKey]) {
          delete cache[workspaceKey];
          await this._writeCache(cache);
        }
      });

      logger.info(`Deregistered workspace on port ${this.port}`, {
        port: this.port,
        cwd: process.cwd()
      });
    } catch (error) {
      logger.error('WORKSPACE_CACHE_DEREGISTER_ERROR', `Failed to deregister workspace: ${error.message}`, {
        port: this.port,
        error: error.message
      }, false);
      // Don't throw on deregister errors to avoid blocking shutdown
    }
  }

  /**
   * Start watching the cache file for changes
   */
  async startWatching() {
    if (this.isWatching) {
      return;
    }

    try {
      this.watcher = chokidar.watch(this.cacheFilePath, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 100,
          pollInterval: 50
        }
      });

      this.watcher.on('change', async () => {
        try {
          const workspaces = await this._readCache();
          this.emit('workspacesUpdated', workspaces);
          logger.debug('Workspace cache updated', {
            activeWorkspaces: Object.keys(workspaces).length
          });
        } catch (error) {
          logger.error('WORKSPACE_CACHE_WATCH_ERROR', `Error reading cache on file change: ${error.message}`, {
            error: error.message
          }, false);
        }
      });

      this.watcher.on('error', (error) => {
        logger.error('WORKSPACE_CACHE_WATCH_ERROR', `Workspace cache watcher error: ${error.message}`, {
          error: error.message
        }, false);
      });

      this.isWatching = true;
      logger.debug('Started watching workspace cache file');
    } catch (error) {
      logger.error('WORKSPACE_CACHE_WATCH_START_ERROR', `Failed to start watching workspace cache: ${error.message}`, {
        error: error.message
      }, false);
      throw error;
    }
  }

  /**
   * Stop watching the cache file
   */
  async stopWatching() {
    if (!this.isWatching || !this.watcher) {
      return;
    }

    try {
      await this.watcher.close();
      this.watcher = null;
      this.isWatching = false;
      logger.debug('Stopped watching workspace cache file');
    } catch (error) {
      logger.error('WORKSPACE_CACHE_WATCH_STOP_ERROR', `Error stopping workspace cache watcher: ${error.message}`, {
        error: error.message
      }, false);
    }
  }

  /**
   * Get all active workspaces from the cache
   */
  async getActiveWorkspaces() {
    try {
      return await this._readCache();
    } catch (error) {
      logger.error('WORKSPACE_CACHE_READ_ERROR', `Failed to read workspace cache: ${error.message}`, {
        error: error.message
      }, false);
      return {};
    }
  }

  /**
   * Clean up stale entries (where the process is no longer running)
   */
  async cleanupStaleEntries() {
    try {
      await this._withLock(async () => {
        const cache = await this._readCache();
        const cleanedCache = {};
        let removedCount = 0;

        for (const [workspaceKey, entry] of Object.entries(cache)) {
          if (await this._isProcessRunning(entry.pid)) {
            cleanedCache[workspaceKey] = entry;
          } else {
            logger.debug(`Removing stale workspace entry: ${workspaceKey} (PID: ${entry.pid})`);
            removedCount++;
          }
        }

        if (removedCount > 0) {
          await this._writeCache(cleanedCache);
          logger.info(`Cleaned up ${removedCount} stale workspace entries`);
        }
      });
    } catch (error) {
      logger.error('WORKSPACE_CACHE_CLEANUP_ERROR', `Failed to cleanup stale entries: ${error.message}`, {
        error: error.message
      }, false);
    }
  }

  /**
   * Shutdown the cache manager
   */
  async shutdown() {
    await this.stopWatching();
    await this.deregister();
    this.removeAllListeners();
    logger.debug('WorkspaceCacheManager shutdown complete');
  }

  // Private methods

  /**
   * Ensure the cache file exists, creating an empty one if necessary
   */
  async _ensureCacheFile() {
    try {
      await fs.access(this.cacheFilePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        await this._writeCache({});
      } else {
        throw error;
      }
    }
  }

  /**
   * Read the workspace cache from disk
   */
  async _readCache() {
    try {
      const content = await fs.readFile(this.cacheFilePath, 'utf8');
      return JSON.parse(content || '{}');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {};
      }
      throw error;
    }
  }

  /**
   * Write the workspace cache to disk
   */
  async _writeCache(cache) {
    const content = JSON.stringify(cache, null, 2);
    await fs.writeFile(this.cacheFilePath, content, 'utf8');
  }

  /**
   * Execute a function with file locking to prevent race conditions
   */
  async _withLock(fn) {
    const maxRetries = 10;
    const retryDelay = 50; // ms

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Simple lock implementation using exclusive file creation
        await fs.writeFile(this.lockFilePath, process.pid.toString(), { flag: 'wx' });

        try {
          await fn();
        } finally {
          // Always clean up the lock file
          try {
            await fs.unlink(this.lockFilePath);
          } catch (unlinkError) {
            // Ignore unlink errors as they're not critical
          }
        }
        return; // Success, exit retry loop
      } catch (error) {
        if (error.code === 'EEXIST') {
          // Lock file exists, wait and retry
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          continue;
        }
        throw error; // Other errors are not retry-able
      }
    }

    throw new Error(`Failed to acquire lock after ${maxRetries} attempts`);
  }

  /**
   * Check if a process is still running
   */
  async _isProcessRunning(pid) {
    try {
      // Sending signal 0 checks if process exists without actually sending a signal
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  }
}
