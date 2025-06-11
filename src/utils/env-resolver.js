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
    this.strict = options.strict !== false; // Default to strict mode
  }

  /**
   * Resolve all placeholders in a configuration object
   * @param {Object} config - Configuration object with fields to resolve
   * @param {Array} fieldsToResolve - Fields that should be resolved ['env', 'args', 'headers', 'url', 'command']
   * @returns {Object} - Resolved configuration
   */
  async resolveConfig(config, fieldsToResolve = ['env', 'args', 'headers', 'url', 'command']) {
    const resolved = JSON.parse(JSON.stringify(config)); // Deep clone

    // Start with process.env as base context
    let context = { ...process.env };

    // Resolve env field first if present (provides context for other fields)
    if (resolved.env && fieldsToResolve.includes('env')) {
      resolved.env = await this._resolveFieldUniversal(resolved.env, context, 'env');
      // Update context with resolved env values
      context = { ...context, ...resolved.env };
    }

    // Resolve other fields using the updated context
    for (const field of fieldsToResolve) {
      if (field !== 'env' && resolved[field] !== undefined) {
        resolved[field] = await this._resolveFieldUniversal(resolved[field], context, field);
      }
    }

    return resolved;
  }


  /**
   * Universal field resolver that handles any field type with ${} placeholders
   */
  async _resolveFieldUniversal(fieldValue, context, fieldType) {
    if (fieldType === 'env' && typeof fieldValue === 'object') {
      // Handle env object with multi-pass resolution
      return await this._resolveEnvObject(fieldValue, context);
    }

    if (fieldType === 'args' && Array.isArray(fieldValue)) {
      const resolvedArgs = [];
      for (const arg of fieldValue) {
        if (typeof arg === 'string') {
          // Handle legacy $VAR syntax for backward compatibility
          if (arg.startsWith('$') && !arg.startsWith('${')) {
            logger.warn(`DEPRECATED: Legacy argument syntax '$VAR' is deprecated. Use '\${VAR}' instead. Found: ${arg}`);
            const envKey = arg.substring(1);
            const resolvedValue = context[envKey];
            if (resolvedValue === undefined && this.strict) {
              throw new Error(`Legacy variable '${envKey}' not found`);
            }
            resolvedArgs.push(resolvedValue || arg);
          } else {
            resolvedArgs.push(await this._resolveStringWithPlaceholders(arg, context));
          }
        } else {
          resolvedArgs.push(arg);
        }
      }
      return resolvedArgs;
    }

    if (fieldType === 'headers' && typeof fieldValue === 'object') {
      const resolved = {};
      for (const [key, value] of Object.entries(fieldValue)) {
        if (typeof value === 'string') {
          resolved[key] = await this._resolveStringWithPlaceholders(value, context);
        } else {
          resolved[key] = value;
        }
      }
      return resolved;
    }

    if ((fieldType === 'url' || fieldType === 'command') && typeof fieldValue === 'string') {
      return await this._resolveStringWithPlaceholders(fieldValue, context);
    }

    return fieldValue;
  }

  /**
   * Resolve env object - simple single-pass resolution
   */
  async _resolveEnvObject(envConfig, baseContext) {
    const resolved = {};

    for (const [key, value] of Object.entries(envConfig)) {
      if (value === null || value === '') {
        // Handle null/empty fallback to process.env
        const fallbackValue = baseContext[key];
        if (fallbackValue === undefined && this.strict) {
          throw new Error(`Variable '${key}' not found`);
        }
        resolved[key] = fallbackValue || '';
      } else {
        // For non-null/empty values, resolve placeholders
        resolved[key] = await this._resolveStringWithPlaceholders(value, baseContext);
      }
    }

    return resolved;
  }

  /**
   * Resolve all ${} placeholders in a string (can handle multiple placeholders)
   */
  async _resolveStringWithPlaceholders(str, context) {
    if (typeof str !== 'string') return str;

    // Find all ${...} patterns
    const placeholderRegex = /\$\{([^}]+)\}/g;
    let result = str;
    let match;

    // Use a set to track processed placeholders to avoid infinite loops
    const processedPlaceholders = new Set();

    while ((match = placeholderRegex.exec(str)) !== null) {
      const fullMatch = match[0]; // ${...}
      const content = match[1].trim(); // content inside {}

      if (processedPlaceholders.has(fullMatch)) {
        continue; // Skip already processed placeholders
      }
      processedPlaceholders.add(fullMatch);

      try {
        let resolvedValue;

        if (content.startsWith('cmd:')) {
          // Execute command
          try {
            resolvedValue = await this._executeCommand(fullMatch);
          } catch (cmdError) {
            if (this.strict) {
              throw new Error(`cmd execution failed: ${cmdError.message}`);
            }
            logger.warn(`Failed to execute command in placeholder ${fullMatch}: ${cmdError.message}`);
            continue; // Keep original placeholder
          }
        } else {
          // Environment variable lookup
          resolvedValue = context[content];
          if (resolvedValue === undefined) {
            if (this.strict) {
              throw new Error(`Variable '${content}' not found`);
            }
            logger.debug(`Unresolved placeholder: ${fullMatch}`);
            continue; // Keep original placeholder
          }
        }

        // Replace the placeholder with resolved value
        result = result.replace(fullMatch, resolvedValue);
      } catch (error) {
        if (this.strict) {
          throw error; // Re-throw in strict mode
        }
        logger.warn(`Failed to resolve placeholder ${fullMatch}: ${error.message}`);
        // Keep original placeholder on error
      }
    }

    return result;
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
      const match = value.match(/\$\{cmd:\s*([^}]*)\}/);
      if (match) {
        command = match[1].trim();
      } else {
        throw new Error(`Invalid command syntax: ${value}`);
      }
    }

    if (!command) {
      throw new Error(`Empty command in ${value}`);
    }

    logger.debug(`Executing command: ${command}`);
    const { stdout } = await execPromise(command, {
      timeout: this.commandTimeout,
      encoding: 'utf8'
    });

    return stdout.trim();
  }

}

// Export singleton instance with strict mode enabled
export const envResolver = new EnvResolver({ strict: true });

// Export legacy function for backward compatibility
export async function resolveEnvironmentVariables(envConfig) {
  logger.warn('DEPRECATED: resolveEnvironmentVariables function is deprecated, use EnvResolver.resolveConfig instead');
  const resolver = new EnvResolver();
  const resolved = await resolver.resolveConfig({ env: envConfig }, ['env']);
  return { ...process.env, ...resolved.env };
}
