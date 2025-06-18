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
   * Resolve all ${} placeholders in a string, with support for nested placeholders.
   */
  async _resolveStringWithPlaceholders(str, context, depth = 0) {
    if (depth > this.maxPasses) {
      throw new Error('Max placeholder resolution depth exceeded, possible circular reference.');
    }

    if (typeof str !== 'string' || !str.includes('${')) {
      return str;
    }

    const placeholders = this._findTopLevelPlaceholders(str);
    if (placeholders.length === 0) {
      return str;
    }

    let result = '';
    let lastIndex = 0;

    for (const { fullMatch, content, startIndex, endIndex } of placeholders) {
      // Append text before the current placeholder
      result += str.substring(lastIndex, startIndex);

      // Recursively resolve placeholders within the content of the current placeholder
      const resolvedContent = await this._resolveStringWithPlaceholders(content, context, depth + 1);

      let resolvedValue;
      const isCommand = resolvedContent.startsWith('cmd:');

      try {
        if (isCommand) {
          // Execute command directly with resolved content
          resolvedValue = await this._executeCommandContent(resolvedContent);
        } else {
          // Environment variable lookup
          resolvedValue = context[resolvedContent];
          if (resolvedValue === undefined) {
            if (this.strict) {
              throw new Error(`Variable '${resolvedContent}' not found`);
            }
            logger.debug(`Unresolved placeholder: ${fullMatch}`);
            resolvedValue = fullMatch; // Keep original placeholder if not found and not in strict mode
          }
        }
      } catch (error) {
        if (this.strict) {
          // Wrap command execution errors with context
          if (isCommand) {
            throw new Error(`cmd execution failed: ${error.message}`);
          }
          throw error; // Re-throw other errors (like variable not found)
        }
        logger.warn(`Failed to resolve placeholder ${fullMatch}: ${error.message}`);
        resolvedValue = fullMatch; // Keep original placeholder on error
      }

      result += resolvedValue;
      lastIndex = endIndex;
    }

    // Append the rest of the string after the last placeholder
    result += str.substring(lastIndex);

    return result;
  }


  /**
   * Finds top-level placeholders ${...} in a string, correctly handling nested ones.
   * @returns {Array<{fullMatch: string, content: string, startIndex: number, endIndex: number}>}
   */
  _findTopLevelPlaceholders(str) {
    const placeholders = [];
    let searchIndex = 0;
    const strLength = str.length;

    while (searchIndex < strLength) {
      const startIndex = str.indexOf('${', searchIndex);
      if (startIndex === -1) {
        break;
      }

      let braceCount = 1;
      let endIndex = -1;

      for (let i = startIndex + 2; i < strLength; i++) {
        const char = str[i];

        if (char === '$' && i + 1 < strLength && str[i + 1] === '{') {
          braceCount++;
          i++; // Skip the '{' to avoid double counting
        } else if (char === '}') {
          braceCount--;
          if (braceCount === 0) {
            endIndex = i;
            break;
          }
        }
      }

      if (endIndex !== -1) {
        const fullMatch = str.substring(startIndex, endIndex + 1);
        const content = str.substring(startIndex + 2, endIndex);
        placeholders.push({ fullMatch, content, startIndex, endIndex: endIndex + 1 });
        searchIndex = endIndex + 1;
      } else {
        // Unmatched opening brace, continue search after it
        searchIndex = startIndex + 2;
      }
    }
    return placeholders;
  }


  /**
   * Check if value contains command syntax
   */
  _isCommand(value) {
    return typeof value === 'string' &&
      (value.startsWith('$:') || /\$\{cmd:\s*[^}]+\}/.test(value));
  }

  /**
   * Execute command content (without ${} wrapper) and return trimmed output
   */
  async _executeCommandContent(content) {
    // content is already resolved and should be "cmd: command args"
    const command = content.slice(4).trim(); // Remove "cmd:" prefix

    if (!command) {
      throw new Error(`Empty command in cmd: ${content}`);
    }

    logger.debug(`Executing command: ${command}`);
    const { stdout } = await execPromise(command, {
      timeout: this.commandTimeout,
      encoding: 'utf8'
    });

    return stdout.trim();
  }

  /**
  /**
   * Execute command and return trimmed output (wrapper for backward compatibility)
   */
  async _executeCommand(value) {
    if (value.startsWith('$:')) {
      // Legacy syntax: $: command args (deprecated but still supported)
      logger.warn(`DEPRECATED: Legacy command syntax '$:' is deprecated. Use '\${cmd: command args}' instead. Found: ${value}`);
      const command = value.slice(2).trim();
      if (!command) {
        throw new Error(`Empty command in ${value}`);
      }
      logger.debug(`Executing command: ${command}`);
      const { stdout } = await execPromise(command, {
        timeout: this.commandTimeout,
        encoding: 'utf8'
      });
      return stdout.trim();
    } else if (value.startsWith('${cmd:') && value.endsWith('}')) {
      // New syntax: ${cmd: command args} - extract content and delegate
      const content = value.slice(2, -1); // Remove ${ and }
      return this._executeCommandContent(content);
    } else {
      throw new Error(`Invalid command syntax: ${value}`);
    }
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
