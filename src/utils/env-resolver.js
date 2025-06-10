import { exec } from 'child_process';
import { promisify } from 'util';
import logger from './logger.js';

const execPromise = promisify(exec);

/**
 * Universal environment variable resolver with support for:
 * - ${ENV_VAR} - resolve from context then process.env
 * - ${cmd: command args} - execute command and use output
 * - Recursive resolution with cycle detection
 * - Safe resolution from adjacent fields
 */
export class EnvResolver {
  constructor(options = {}) {
    this.maxPasses = options.maxPasses || 10;
    this.commandTimeout = options.commandTimeout || 30000;
  }

  /**
   * Resolve all placeholders in a configuration object
   * @param {Object} config - Configuration object with fields to resolve
   * @param {Array} fieldsToResolve - Fields that should be resolved ['env', 'args', 'headers', 'url', 'command']
   * @returns {Object} - Resolved configuration
   */
  async resolveConfig(config, fieldsToResolve = ['env', 'args', 'headers', 'url', 'command']) {
    const resolved = JSON.parse(JSON.stringify(config)); // Deep clone

    // Create resolution context from env field for cross-field resolution
    const envContext = await this._buildEnvContext(resolved.env || {});

    // Resolve each field type
    for (const field of fieldsToResolve) {
      if (resolved[field] !== undefined) {
        resolved[field] = await this._resolveField(resolved[field], envContext, field);
      }
    }

    return resolved;
  }

  /**
   * Build environment context from env field with command execution
   * This creates a safe resolution order to prevent recursion
   */
  async _buildEnvContext(envConfig) {
    const context = { ...process.env }; // Start with process.env as base
    const envEntries = Object.entries(envConfig);

    // First pass: Execute all commands (${cmd: ...})
    const commandResults = {};
    for (const [key, value] of envEntries) {
      if (typeof value === 'string' && this._isCommand(value)) {
        try {
          commandResults[key] = await this._executeCommand(value);
        } catch (error) {
          logger.warn(`Failed to execute command for ${key}: ${error.message}`);
          commandResults[key] = value; // Keep original on error
        }
      }
    }

    // Second pass: Resolve environment variables with multi-pass for dependencies
    const envValues = { ...commandResults };
    let unresolved = envEntries
      .filter(([key, value]) => !commandResults[key])
      .map(([key, value]) => ({ key, value: value || process.env[key] || '' }));

    let passCount = 0;
    while (unresolved.length > 0 && passCount < this.maxPasses) {
      const nextUnresolved = [];

      for (const { key, value } of unresolved) {
        const resolved = this._resolvePlaceholders(value, { ...context, ...envValues });

        if (this._hasUnresolvedPlaceholders(resolved)) {
          nextUnresolved.push({ key, value });
        } else {
          envValues[key] = resolved;
        }
      }

      // Break if no progress made (circular dependencies)
      if (nextUnresolved.length === unresolved.length) {
        logger.warn(`Circular dependencies detected in env variables: ${nextUnresolved.map(u => u.key).join(', ')}`);
        // Keep original values
        nextUnresolved.forEach(({ key, value }) => {
          envValues[key] = value;
        });
        break;
      }

      unresolved = nextUnresolved;
      passCount++;
    }

    return { ...context, ...envValues };
  }

  /**
  /**
   * Resolve a specific field (env, args, headers, url, command)
   */
  async _resolveField(fieldValue, context, fieldType) {
    if (fieldType === 'env') {
      // env field resolution: use context values when available
      const result = {};
      for (const [key, value] of Object.entries(fieldValue)) {
        result[key] = context.hasOwnProperty(key) ? context[key] : undefined;
      }
      return result;
    }

    if (fieldType === 'args' && Array.isArray(fieldValue)) {
      return fieldValue.map(arg => {
        if (typeof arg === 'string') {
          // Handle legacy $VAR syntax for backward compatibility
          if (arg.startsWith('$') && !arg.startsWith('${')) {
            logger.warn(`DEPRECATED: Legacy argument syntax '$VAR' is deprecated. Use '\${VAR}' instead. Found: ${arg}`);
            const envKey = arg.substring(1);
            return context[envKey] || arg;
          }
          return this._resolvePlaceholders(arg, context);
        }
        return arg;
      });
    }

    if (fieldType === 'headers' && typeof fieldValue === 'object') {
      const resolved = {};
      for (const [key, value] of Object.entries(fieldValue)) {
        resolved[key] = typeof value === 'string'
          ? this._resolvePlaceholders(value, context)
          : value;
      }
      return resolved;
    }

    if ((fieldType === 'url' || fieldType === 'command') && typeof fieldValue === 'string') {
      return this._resolvePlaceholders(fieldValue, context);
    }

    return fieldValue;
  }

  /**
   * Resolve ${...} placeholders in a string
   */
  _resolvePlaceholders(value, context) {
    if (typeof value !== 'string') return value;

    return value.replace(/\$\{([^}]+)\}/g, (match, content) => {
      const trimmed = content.trim();

      // Handle command execution: ${cmd: command args}
      if (trimmed.startsWith('cmd:')) {
        // Commands should already be resolved in context
        // This is a fallback for any missed commands
        logger.warn(`Command placeholder found during field resolution: ${match}`);
        return match; // Keep original
      }

      // Handle environment variable: ${VAR_NAME}
      if (context.hasOwnProperty(trimmed)) {
        return context[trimmed];
      }

      // Log unresolved placeholder
      logger.debug(`Unresolved placeholder: ${match}`);
      return match; // Keep original placeholder
    });
  }

  /**
   * Check if value contains command syntax
   */
  _isCommand(value) {
    return typeof value === 'string' &&
      (value.startsWith('$:') || /\$\{cmd:\s*[^}]+\}/.test(value));
  }

  /**
   * Execute command and return trimmed output
   */
  async _executeCommand(value) {
    let command;

    if (value.startsWith('$:')) {
      // Legacy syntax: $: command args
      logger.warn(`DEPRECATED: Legacy command syntax '$:' is deprecated. Use '\${cmd: command args}' instead. Found: ${value}`);
      command = value.slice(2).trim();
    } else {
      // New syntax: ${cmd: command args}
      const match = value.match(/\$\{cmd:\s*([^}]+)\}/);
      if (match) {
        command = match[1].trim();
      } else {
        throw new Error(`Invalid command syntax: ${value}`);
      }
    }

    logger.debug(`Executing command: ${command}`);
    const { stdout } = await execPromise(command, {
      timeout: this.commandTimeout,
      encoding: 'utf8'
    });

    return stdout.trim();
  }

  /**
   * Check if string has unresolved placeholders
   */
  _hasUnresolvedPlaceholders(value) {
    return typeof value === 'string' && /\$\{[^}]+\}/.test(value);
  }
}

// Export singleton instance
export const envResolver = new EnvResolver();

// Export legacy function for backward compatibility
export async function resolveEnvironmentVariables(envConfig) {
  logger.warn('DEPRECATED: resolveEnvironmentVariables function is deprecated, use EnvResolver.resolveConfig instead');
  const resolver = new EnvResolver();
  return await resolver._buildEnvContext(envConfig);
}
