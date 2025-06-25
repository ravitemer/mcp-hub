import fs from "fs";
import path from "path";
import { getLogDirectory } from "./xdg-paths.js";

/**
 * Logger class that handles both file and console logging with structured JSON output
 */

const LOG_DIR = getLogDirectory();
const LOG_FILE = "mcp-hub.log";
class Logger {
  constructor(options = {}) {
    this.logFile = options.logFile || path.join(LOG_DIR, LOG_FILE);
    this.logLevel = options.logLevel || 'info';
    this.enableFileLogging = options.enableFileLogging !== false
    this.sseManager = null;

    this.LOG_LEVELS = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3,
    };

    // Initialize logging
    this.initializeLogFile();
    this.setupErrorHandlers();
  }

  /**
   * Sets the SSE manager for real-time log streaming
   * @param {SSEManager} manager SSE manager instance
   */
  setSseManager(manager) {
    this.sseManager = manager;
  }

  /**
   * Initialize log file
   */
  initializeLogFile() {
    if (!this.enableFileLogging) return;

    try {
      const logDir = path.dirname(this.logFile);
      fs.mkdirSync(logDir, { recursive: true });
      //--empty the log file
      fs.writeFileSync(this.logFile, '');
    } catch (error) {
      console.error(`Failed to initialize log file: ${error.message}`);
      this.enableFileLogging = false;
    }
  }

  /**
   * Setup error handlers for EPIPE
   */
  setupErrorHandlers() {
    const handleError = (error) => {
      //INFO: when mcp-hub is not started from a terminal, but bya program when the program is closed, writing to stdout,stderr will throw an EPIPE error
      if (error.code !== 'EPIPE') {
        console.error('Stream error:', error);
      }
    };

    process.stdout.on('error', handleError);
    process.stderr.on('error', handleError);
  }

  /**
   * Core logging method that all other methods use
   */
  log(type, message, data = {}, code = null, options = {}) {
    const { exit = false, exitCode = 1, level = type } = options;

    if (this.LOG_LEVELS[this.logLevel] < this.LOG_LEVELS[level]) return;

    const entry = {
      type,
      message,
      data,
      timestamp: new Date().toISOString(),
      ...(code && { code }),
    };

    // Console output
    const consoleMethod = type === 'error' ? 'error' :
      type === 'warn' ? 'warn' :
        type === 'debug' ? 'debug' : 'log';

    console[consoleMethod](JSON.stringify(entry));

    this.file(entry.message)
    // Broadcast through SSE if available and appropriate level
    if (this.sseManager && this.LOG_LEVELS[level] <= this.LOG_LEVELS[this.logLevel]) {
      this.sseManager.broadcast('log', entry);
    }

    if (exit) {
      //sigterm
      process.emit('SIGTERM');
      // process.exit(exitCode);
    }
  }

  file(message, data = {}) {
    // File output
    if (this.enableFileLogging) {
      try {
        fs.appendFileSync(this.logFile, message + '\n');
      } catch (error) {
        if (error.code !== 'EPIPE') {
          this.enableFileLogging = false;
        }
      }
    }
  }

  /**
   * Log status update
   */
  logUpdate(metadata = {}) {
    this.log('info', 'MCP Hub status updated', metadata, 'MCP_HUB_UPDATED');
  }

  /**
   * Log capability changes
   */
  logCapabilityChange(type, serverName, data = {}) {
    this.log(
      'info',
      `${serverName} ${type.toLowerCase()} list updated`,
      { type, server: serverName, ...data },
      `${type}_LIST_CHANGED`
    );
  }

  /**
   * Log info message
   */
  info(message, data = {}) {
    this.log('info', message, data);
  }

  /**
   * Log warning message
   */
  warn(message, data = {}) {
    this.log('warn', message, data);
  }

  /**
   * Log debug message
   */
  debug(message, data = {}) {
    this.log('debug', message, data);
  }

  /**
   * Log error message
   */
  error(code, message, data = {}, exit = true, exitCode = 1) {
    this.log('error', message, data, code, { exit, exitCode });
  }

  /**
   * Set log level
   */
  setLogLevel(level) {
    if (this.LOG_LEVELS[level] !== undefined) {
      this.logLevel = level;
    }
  }

  /**
   * Enable/disable file logging
   */
  setFileLogging(enable) {
    this.enableFileLogging = enable;
    if (enable) {
      this.initializeLogFile();
    }
  }
}

// Create logger instance
const logger = new Logger({
  logLevel: "debug",
});

// Handle unhandled errors
process.on("uncaughtException", (error) => {
  logger.error(
    error.code || "UNHANDLED_ERROR",
    `An unhandled error occurred: ${error}`,
    { message: error.message, stack: error.stack }
  );
});

// Handle unhandled promise rejections 
process.on("unhandledRejection", (error) => {
  logger.error(
    "UNHANDLED_REJECTION",
    `An unhandled rejection occurred: ${error}`,
  );
});

export default logger;
