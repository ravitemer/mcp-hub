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
            resolvedArgs.push(context[envKey] || arg);
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
   * Resolve env object with multi-pass resolution for dependencies
   */
  async _resolveEnvObject(envConfig, baseContext) {
    const resolved = {};
    const unresolved = Object.entries(envConfig);
    let passCount = 0;

    // Create working context that includes both base context and resolved values
    let workingContext = { ...baseContext };

    while (unresolved.length > 0 && passCount < this.maxPasses) {
      const stillUnresolved = [];
      let madeProgress = false;

      for (const [key, value] of unresolved) {
        // Handle null/empty fallback to process.env
        let valueToResolve = value;
        if (value === null || value === '') {
          valueToResolve = baseContext[key] || '';
        }

        const resolvedValue = await this._resolveStringWithPlaceholders(valueToResolve, workingContext);

        if (this._hasUnresolvedPlaceholders(resolvedValue)) {
          stillUnresolved.push([key, value]);
        } else {
          resolved[key] = resolvedValue;
          workingContext[key] = resolvedValue; // Add to working context
          madeProgress = true;
        }
      }

      if (!madeProgress) {
        logger.warn(`Circular dependencies detected in env variables: ${stillUnresolved.map(([k]) => k).join(', ')}`);
        // Add unresolved values as-is with fallback
        stillUnresolved.forEach(([key, value]) => {
          resolved[key] = value || baseContext[key] || '';
        });
        break;
      }

      unresolved.length = 0;
      unresolved.push(...stillUnresolved);
      passCount++;
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
          resolvedValue = await this._executeCommand(fullMatch);
        } else {
          // Environment variable lookup
          resolvedValue = context[content];
          if (resolvedValue === undefined) {
            logger.debug(`Unresolved placeholder: ${fullMatch}`);
            continue; // Keep original placeholder
          }
        }

        // Replace the placeholder with resolved value
        result = result.replace(fullMatch, resolvedValue);
      } catch (error) {
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
  const resolved = await resolver.resolveConfig({ env: envConfig }, ['env']);
  return { ...process.env, ...resolved.env };
}
