/**
 * Base error class for MCP Hub errors
 * All errors should extend from this to ensure consistent structure
 */
export class MCPHubError extends Error {
  constructor(code, message, data = {}) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = "MCPHubError";

    // Preserve the proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Format error for logging
   */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      data: this.data,
      stack: this.stack,
    };
  }
}

/**
 * Configuration related errors
 */
export class ConfigError extends MCPHubError {
  constructor(message, data = {}) {
    super("CONFIG_ERROR", message, data);
    this.name = "ConfigError";
  }
}

/**
 * Server connection related errors
 */
export class ConnectionError extends MCPHubError {
  constructor(message, data = {}) {
    super("CONNECTION_ERROR", message, data);
    this.name = "ConnectionError";
  }
}

/**
 * Server startup/initialization errors
 */
export class ServerError extends MCPHubError {
  constructor(message, data = {}) {
    super("SERVER_ERROR", message, data);
    this.name = "ServerError";
  }
}

/**
 * Tool execution related errors
 */
export class ToolError extends MCPHubError {
  constructor(message, data = {}) {
    super("TOOL_ERROR", message, data);
    this.name = "ToolError";
  }
}

/**
 * Resource access related errors
 */
export class ResourceError extends MCPHubError {
  constructor(message, data = {}) {
    super("RESOURCE_ERROR", message, data);
    this.name = "ResourceError";
  }
}

/**
 * Request validation errors
 */
export class ValidationError extends MCPHubError {
  constructor(message, data = {}) {
    super("VALIDATION_ERROR", message, data);
    this.name = "ValidationError";
  }
}

/**
 * Helper function to determine if error is one of our custom errors
 */
export function isMCPHubError(error) {
  return error instanceof MCPHubError;
}

/**
 * Helper function to wrap unknown errors as MCPHubError
 */
export function wrapError(error, code = "UNEXPECTED_ERROR", data = {}) {
  if (isMCPHubError(error)) {
    return error;
  }

  return new MCPHubError(error.code || code, error.message, {
    ...data,
    originalError: error,
  });
}
