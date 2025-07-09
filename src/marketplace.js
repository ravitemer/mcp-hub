import fs from "fs/promises";
import path from "path";
import { promisify } from "util";
import { exec as execCb } from "child_process";
import logger from "./utils/logger.js";
import { MCPHubError } from "./utils/errors.js";
import { getCacheDirectory } from "./utils/xdg-paths.js";

const exec = promisify(execCb);

/**
 * Check if curl is available and execute curl command
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @returns {Promise<{ok: boolean, status: number, json: () => Promise<any>}>}
 */
async function executeCurl(url, options = {}) {
  try {
    // Check if curl exists
    await exec('curl --version');

    // Base command with silent mode
    let curlCmd = ['curl', '-s'];

    if (options.method === 'POST') {
      curlCmd.push('-X', 'POST');
    }

    if (options.headers) {
      Object.entries(options.headers).forEach(([key, value]) => {
        curlCmd.push('-H', `"${key}: ${value}"`);
      });
    }

    if (options.body) {
      // Handle body data properly
      const processedBody = typeof options.body === 'string' ?
        options.body :
        JSON.stringify(options.body);
      curlCmd.push('-d', `'${processedBody}'`);
    }

    curlCmd.push(url);

    const { stdout } = await exec(curlCmd.join(' '));

    // If we get output, try to parse it as JSON
    if (stdout) {
      return {
        ok: true,  // Since we got a response
        status: 200,
        json: async () => JSON.parse(stdout)
      };
    }

    throw new Error('No response from curl');
  } catch (error) {
    throw new MarketplaceError('Failed to execute curl command', {
      error: error.message
    });
  }
}

/**
 * Fetch with curl fallback
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 */
async function fetchWithFallback(url, options = {}) {
  try {
    return await fetch(url, options);
  } catch (error) {
    logger.warn("Fetch failed, falling back to curl", { error: error.message });
    return await executeCurl(url, options);
  }
}

const CACHE_DIR = getCacheDirectory();
const CACHE_FILE = "registry.json";
const DEFAULT_TTL = 60 * 60 * 1000; // 1 hour in milliseconds

// New MCP Registry Endpoint
const REGISTRY_URL = "https://ravitemer.github.io/mcp-registry/registry.json";

/**
 * @typedef {Object} McpRegistryParameter
 * @property {string} name
 * @property {string} key
 * @property {string} [description]
 * @property {string} [placeholder]
 * @property {boolean} [required]
 */

/**
 * @typedef {Object} McpRegistryInstallation
 * @property {string} name
 * @property {string} [description]
 * @property {string} config
 * @property {string[]} [prerequisites]
 * @property {McpRegistryParameter[]} [parameters]
 * @property {('stdio'|'sse'|'streamable-http')[]} [transports]
 */

/**
 * @typedef {Object} McpRegistryServer
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string} author
 * @property {string} url
 * @property {string} [license]
 * @property {string} category
 * @property {string[]} tags
 * @property {McpRegistryInstallation[]} installations
 * @property {boolean} [featured]
 * @property {boolean} [verified]
 * @property {number} [stars]
 * @property {number} [lastCommit]
 * @property {number} [updatedAt]
 */

/**
 * @typedef {Object} McpRegistryData
 * @property {string} version
 * @property {number} generatedAt
 * @property {number} totalServers
 * @property {McpRegistryServer[]} servers
 */

/**
 * @typedef {Object} MarketplaceCacheData
 * @property {McpRegistryData|null} registry - The fetched MCP Registry data
 * @property {number|null} lastFetchedAt - Timestamp of the last successful registry fetch
 * @property {Object.<string, {content: string, lastFetchedAt: number}>} [serverDocumentation] - Cached documentation content for individual servers, keyed by mcpId
 */

/**
 * @typedef {Object} MarketplaceQueryOptions
 * @property {string} [search] - Search term for filtering
 * @property {string} [category] - Category filter
 * @property {string[]} [tags] - Array of tags to filter by
 * @property {'newest'|'stars'|'name'} [sort] - Sort order
 */

class MarketplaceError extends MCPHubError {
  constructor(message, data = {}) {
    super("MARKETPLACE_ERROR", message, data);
    this.name = "MarketplaceError";
  }
}

/**
 * Manages the MCP server marketplace including registry fetching,
 * server details, caching, and search functionality.
 */
export class Marketplace {
  /**
   * @param {number} ttl - Cache time-to-live in milliseconds
   */
  constructor(ttl = DEFAULT_TTL) {
    this.ttl = ttl;
    this.cacheFile = path.join(CACHE_DIR, CACHE_FILE);
    /** @type {MarketplaceCacheData} */
    this.cache = {
      registry: null,
      lastFetchedAt: null,
      serverDocumentation: {}, // Initialize this
    };
  }

  /**
   * Initializes the marketplace by loading or creating the cache and fetching if necessary.
   * @throws {MarketplaceError} If initialization fails catastrophically.
   */
  async initialize() {
    try {
      await fs.mkdir(CACHE_DIR, { recursive: true });

      // Try to load cache first
      try {
        const content = await fs.readFile(this.cacheFile, "utf-8");
        const loaded = JSON.parse(content);
        this.cache = loaded
        logger.debug(`Loaded marketplace cache`, {
          lastFetchedAt: this.cache.lastFetchedAt,
          isFresh: this.isCatalogValid(),
          serverCount: this.cache.registry?.servers?.length || 0,
        });
      } catch (error) {
        if (error.code !== "ENOENT") {
          logger.warn("Failed to load marketplace cache", {
            error: error.message,
          });
        }
        // Initialize empty cache structure if file doesn't exist or is invalid
        this.cache = { registry: null, lastFetchedAt: null, serverDocumentation: {} };
      }

      // If cache is not valid (stale or empty), attempt to fetch fresh data
      if (!this.isCatalogValid()) {
        try {
          await this.fetchRegistry();
          const serverCount = this.cache.registry?.servers?.length || 0;
          logger.info(`Successfully updated marketplace registry with ${serverCount} servers`);
        } catch (error) {
          // If fetch fails but we have stale cache, log warning and use stale data
          if (this.cache.registry) {
            logger.warn(`Using stale marketplace registry due to error: ${error.message}`);
          } else {
            // If no cache at all, log error and continue with empty catalog
            logger.error(
              "MARKETPLACE_INIT_ERROR",
              `Failed to initialize marketplace registry: ${error.message}`,
              {
                error: error.message,
                fallback: "Continuing with empty catalog",
              },
              false
            );
            // Ensure a minimal valid structure if nothing could be fetched
            this.cache.registry = { version: "N/A", generatedAt: 0, totalServers: 0, servers: [] };
          }
        }
      }
    } catch (error) {
      // Catch-all for catastrophic errors during initialization
      logger.error(
        "MARKETPLACE_INIT_ERROR",
        `Failed to initialize marketplace : ${error.message}`,
        {
          error: error.message,
          fallback: "Continuing with empty catalog",
        },
        false
      );
      this.cache = { registry: null, lastFetchedAt: null, serverDocumentation: {} };
    }
  }

  /**
   * Saves the current cache state to disk.
   * @throws {MarketplaceError} If saving fails.
   */
  async saveCache() {
    try {
      await fs.writeFile(
        this.cacheFile,
        JSON.stringify(this.cache, null, 2),
        "utf-8"
      );
    } catch (error) {
      throw new MarketplaceError("Failed to save marketplace cache", {
        error: error.message,
      });
    }
  }

  /**
   * Checks if the cached registry is still valid based on its fetch timestamp.
   * @returns {boolean} True if cache is valid.
   */
  isCatalogValid() {
    if (!this.cache.registry || !this.cache.lastFetchedAt || !(this.cache.registry?.servers?.length)) return false;
    const age = Date.now() - this.cache.lastFetchedAt;
    return age < this.ttl;
  }

  /**
   * Checks if cached server documentation is still valid.
   * @param {string} mcpId - Server ID to check.
   * @returns {boolean} True if documentation cache is valid.
   */
  isDocumentationValid(mcpId) {
    const doc = this.cache.serverDocumentation[mcpId] ?? {}
    if (!doc?.lastFetchedAt) return false;
    const age = Date.now() - doc.lastFetchedAt;
    return age < this.ttl;
  }

  /**
   * Updates cached server documentation.
   * @param {string} mcpId - Server ID.
   * @param {string} content - Documentation content.
   */
  async updateDocumentationCache(mcpId, content) {
    // Defensive: Only store string content
    this.cache.serverDocumentation[mcpId] = {
      content: typeof content === 'string' ? content : '',
      lastFetchedAt: Date.now(),
    };
    await this.saveCache();
  }

  /**
   * Fetches the MCP Registry from the defined URL.
   * @returns {Promise<McpRegistryData>} The fetched registry data.
   * @throws {MarketplaceError} If fetch or parsing fails.
   */
  async fetchRegistry() {
    try {
      logger.debug(`Fetching marketplace registry from ${REGISTRY_URL}`);
      const response = await fetchWithFallback(REGISTRY_URL);

      if (!response.ok) {
        throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      // Basic validation for the new registry structure
      if (!data || !Array.isArray(data.servers)) {
        throw new Error("Invalid registry response format (missing 'servers' array)");
      }

      this.cache.registry = data;
      this.cache.lastFetchedAt = Date.now();
      await this.saveCache();
      return data;
    } catch (error) {
      throw new MarketplaceError("Failed to fetch marketplace registry", {
        url: REGISTRY_URL,
        error: error.message,
      });
    }
  }

  /**
   * Attempts to fetch README.md content from a given GitHub repository URL.
   * Tries 'main' branch first, then 'master'.
   * @private
   * @param {string} repoUrl - The base URL of the GitHub repository (e.g., https://github.com/owner/repo).
   * @returns {Promise<string|null>} The README content as a string, or null if not found/failed.
   */
  async #fetchReadmeContent(repoUrl) {
    const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!match) {
      logger.debug(`URL is not a GitHub repository: ${repoUrl}`);
      return null;
    }
    const [, owner, repo] = match;
    const readmePaths = ['main', 'master'].map(branch =>
      `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`
    );

    for (const readmeUrl of readmePaths) {
      try {
        logger.debug(`Attempting to fetch README from: ${readmeUrl}`);
        const response = await fetchWithFallback(readmeUrl);
        if (response.ok) {
          return await response.text();
        } else if (response.status === 404) {
          logger.debug(`README not found at ${readmeUrl}`);
          continue; // Try next branch
        } else {
          logger.warn(`Failed to fetch README from ${readmeUrl}: HTTP ${response.status}`);
          return null; // Other HTTP error
        }
      } catch (error) {
        logger.warn(`Error fetching README from ${readmeUrl}: ${error.message}`);
        // Do not rethrow, try next URL or return null
      }
    }
    return null; // Could not fetch README from any path
  }

  /**
   * Gets the marketplace catalog with optional filtering and sorting.
   * Ensures the cache is valid before returning.
   * @param {MarketplaceQueryOptions} options - Query options.
   * @returns {Promise<McpRegistryServer[]>} Filtered and sorted server items.
   */
  async getCatalog(options = {}) {
    if (!this.isCatalogValid()) {
      await this.fetchRegistry(); // Attempt to refresh if stale
    }
    return this.queryCatalog(options);
  }

  /**
   * Gets a specific server's details from the cached registry, along with its documentation.
   * @param {string} mcpId - Server ID to retrieve.
   * @returns {Promise<{ server: McpRegistryServer, readmeContent: string|null }|undefined>} The server object and its README content, or undefined if not found.
   */
  async getServerDetails(mcpId) {
    if (!this.isCatalogValid()) {
      await this.fetchRegistry();
    }
    const server = this.cache.registry?.servers.find(s => s.id === mcpId);
    if (!server) {
      return undefined; // Server not found in registry
    }

    let readmeContent = null;
    if (this.isDocumentationValid(mcpId)) {
      const doc = this.cache.serverDocumentation[mcpId];
      readmeContent = typeof doc.content === 'string' ? doc.content : null;
      logger.debug(`Using cached documentation for server '${mcpId}'`);
    } else {
      logger.debug(`Fetching documentation for server '${mcpId}' from URL: ${server.url}`);
      readmeContent = await this.#fetchReadmeContent(server.url);
      if (readmeContent) {
        await this.updateDocumentationCache(mcpId, readmeContent);
        logger.info(`Successfully fetched and cached documentation for '${mcpId}'`);
      } else {
        logger.warn(`Could not fetch documentation for server '${mcpId}'`);
      }
    }

    return {
      server: server,
      readmeContent: readmeContent,
    };
  }

  /**
   * Filters and sorts marketplace items from the current cache.
   * @param {MarketplaceQueryOptions} options - Query options.
   * @returns {McpRegistryServer[]} Filtered and sorted items.
   */
  queryCatalog({ search, category, tags, sort } = {}) {
    let items = this.cache.registry?.servers || [];

    if (search) {
      const searchLower = search.toLowerCase();
      items = items.filter(
        (item) =>
          item.name.toLowerCase().includes(searchLower) ||
          item.description.toLowerCase().includes(searchLower) ||
          item.tags.some((tag) => tag.toLowerCase().includes(searchLower))
      );
    }

    if (category) {
      items = items.filter((item) => item.category === category);
    }

    if (tags && tags.length > 0) {
      items = items.filter((item) =>
        tags.every((tag) => item.tags.includes(tag))
      );
    }

    switch (sort) {
      case "stars":
        items.sort((a, b) => (b.stars || 0) - (a.stars || 0));
        break;
      case "name":
        items.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "newest":
      default:
        // Use lastCommit if available, otherwise fallback to a static value for consistent sorting
        items.sort((a, b) => (b.lastCommit || 0) - (a.lastCommit || 0));
    }

    return items;
  }
}

// Export singleton instance
let instance = null;

/**
 * Gets the singleton Marketplace instance
 * @param {number} [ttl] - Cache TTL in milliseconds
 * @returns {Marketplace} Marketplace instance
 */
export function getMarketplace(ttl = DEFAULT_TTL) {
  if (!instance || (ttl && ttl !== instance.ttl)) {
    instance = new Marketplace(ttl);
  }
  return instance;
}

