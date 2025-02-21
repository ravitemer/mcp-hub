/**
 * Simple logger that outputs structured JSON for both stdout and stderr
 */
const logger = {
  /**
   * Log informational message
   */
  info(message, data = {}) {
    console.log(
      JSON.stringify({
        type: "info",
        message,
        data,
        timestamp: new Date().toISOString(),
      })
    );
  },

  /**
   * Log warning message
   */
  warn(message, data = {}) {
    console.warn(
      JSON.stringify({
        type: "warn",
        message,
        data,
        timestamp: new Date().toISOString(),
      })
    );
  },

  /**
   * Log debug message
   */
  debug(message, data = {}) {
    console.debug(
      JSON.stringify({
        type: "debug",
        message,
        data,
        timestamp: new Date().toISOString(),
      })
    );
  },

  /**
   * Log error with structured output and exit process
   * @param {string} code - Error code
   * @param {string} message - Error message
   * @param {Object} [data] - Additional error data
   * @param {boolean} [exit=true] - Whether to exit process
   * @param {number} [exitCode=0] - Exit code (0 for handled errors, 1 for unexpected)
   */
  error(code, message, data = {}, exit = true, exitCode = 0) {
    console.error(
      JSON.stringify({
        type: "error",
        code,
        message,
        data,
        timestamp: new Date().toISOString(),
      })
    );

    if (exit) {
      process.exit(exitCode);
    }
  },
};

export default logger;
