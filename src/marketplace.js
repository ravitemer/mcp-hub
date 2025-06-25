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

//TODO: implement sort of custom database for reliability instead of using cline mcp-marketplace
const API_BASE_URL = "https://api.cline.bot/v1/mcp";
const CACHE_DIR = getCacheDirectory();
const CACHE_FILE = "marketplace.json";
const DEFAULT_TTL = 24 * 60 * 60 * 1000; // 1 day in milliseconds

/**
 * @typedef {Object} McpMarketplaceItem
 * @property {string} mcpId - Unique identifier for the MCP server (e.g., "github.com/user/repo/path")
 * @property {string} githubUrl - URL to the GitHub repository
 * @property {string} name - Display name of the MCP server
 * @property {string} author - Author/organization name
 * @property {string} description - Brief description of the server's functionality
 * @property {string} codiconIcon - VS Code Codicon name for the icon
 * @property {string} logoUrl - URL to the server's logo image
 * @property {string} category - Primary category (e.g., "search", "ai", "data")
 * @property {string[]} tags - Array of searchable tags
 * @property {boolean} requiresApiKey - Whether the server requires an API key
 * @property {boolean} isRecommended - Whether this is a recommended server
 * @property {number} githubStars - Number of GitHub stars
 * @property {number} downloadCount - Number of times installed
 * @property {string} createdAt - ISO timestamp of creation
 * @property {string} updatedAt - ISO timestamp of last update
 */

/**
 * @typedef {Object} McpServerDetails
 * @property {string} mcpId - Unique identifier for the MCP server
 * @property {string} githubUrl - URL to the GitHub repository
 * @property {string} name - Display name of the MCP server
 * @property {string} description - Brief description of the server's functionality
 * @property {string} readmeContent - Full README content in markdown
 * @property {string} [llmsInstallationContent] - Optional LLM-specific installation instructions
 */

/**
 * @typedef {Object} MarketplaceCacheData
 * @property {Object} catalog
 * @property {McpMarketplaceItem[]} catalog.items
 * @property {string|null} catalog.lastUpdated
 * @property {Object.<string, {data: McpServerDetails, lastUpdated: string}>} serverDetails
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
 * Manages the MCP server marketplace including catalog fetching,
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
      catalog: {
        items: [],
        lastUpdated: null,
      },
      serverDetails: {},
    };
  }

  /**
   * Initializes the marketplace by loading or creating the cache
   * @throws {MarketplaceError} If cache initialization fails
   */
  async initialize() {
    try {
      await fs.mkdir(CACHE_DIR, { recursive: true });

      // First try to load cache (even if stale)
      try {
        const content = await fs.readFile(this.cacheFile, "utf-8");
        this.cache = JSON.parse(content);
        const items = this.cache.catalog.items || [];
        logger.debug(`Loaded marketplace cache: ${items.length} loaded`, {
          catalogItems: items.length,
          isFresh: this.isCatalogValid(),
        });
      } catch (error) {
        if (error.code !== "ENOENT") {
          logger.warn("Failed to load marketplace cache, starting fresh", {
            error: error.message,
          });
        }
        // Initialize empty cache structure
        this.cache = {
          catalog: { items: [], lastUpdated: null },
          serverDetails: {},
        };
      }

      // If no cache or stale, try to fetch fresh data
      if (!this.isCatalogValid()) {
        try {
          await this.fetchCatalog();
          logger.info("Successfully updated marketplace catalog", {
            items: this.cache.catalog.items.length,
          });
        } catch (error) {
          // If fetch fails but we have stale cache, log warning and continue
          if (this.cache.catalog.items.length > 0) {
            logger.warn("Using stale marketplace cache", {
              error: error.message,
              cacheAge:
                Date.now() -
                new Date(this.cache.catalog.lastUpdated || 0).getTime(),
            });
          } else {
            // If no cache at all, log error but continue with empty catalog
            logger.error(
              "MARKETPLACE_INIT_ERROR",
              "Failed to initialize marketplace catalog",
              {
                error: error.message,
                fallback: "Using empty catalog",
              },
              false
            );
            await this.updateCatalog([]); // Ensure we have a valid cache structure
          }
        }
      }
    } catch (error) {
      // Catch-all for catastrophic errors, but still continue
      logger.error(
        "MARKETPLACE_INIT_ERROR",
        "Failed to initialize marketplace",
        {
          error: error.message,
          fallback: "Continuing with empty catalog",
        },
        false
      );
      this.cache = {
        catalog: { items: [], lastUpdated: null },
        serverDetails: {},
      };
    }
  }

  /**
   * Saves the current cache state to disk
   * @throws {MarketplaceError} If saving fails
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
   * Checks if the cached catalog is still valid
   * @returns {boolean} True if cache is valid
   */
  isCatalogValid() {
    if (!this.cache.catalog.lastUpdated || this.cache.catalog.items.length === 0) return false;
    const age = Date.now() - new Date(this.cache.catalog.lastUpdated).getTime();
    return age < this.ttl;
  }

  /**
   * Checks if cached server details are still valid
   * @param {string} mcpId - Server ID to check
   * @returns {boolean} True if cache is valid
   */
  isServerDetailsValid(mcpId) {
    const details = this.cache.serverDetails[mcpId];
    if (!details?.lastUpdated) return false;
    const age = Date.now() - new Date(details.lastUpdated).getTime();
    return age < this.ttl;
  }

  /**
   * Fetches the marketplace catalog from the API
   * @returns {Promise<McpMarketplaceItem[]>} Array of marketplace items
   * @throws {MarketplaceError} If fetch fails
   */
  async fetchCatalog() {
    try {
      logger.debug("Fetching marketplace catalog");
      const response = await fetchWithFallback(`${API_BASE_URL}/marketplace`);

      if (!response.ok) {
        logger.warn("Failed to fetch catalog from API, using cache", {
          status: response.status,
        });
        return this.cache.catalog.items;
      }

      const data = await response.json();
      if (!data || !Array.isArray(data)) {
        logger.warn("Invalid API response format, using cache");
        return this.cache.catalog.items;
      }

      const items = data.map((item) => ({
        ...item,
        githubStars: item.githubStars ?? 0,
        downloadCount: item.downloadCount ?? 0,
        tags: item.tags ?? [],
      }));

      await this.updateCatalog(items);
      return items;
    } catch (error) {
      if (error instanceof MarketplaceError) {
        throw error;
      }
      throw new MarketplaceError("Failed to fetch marketplace catalog", {
        error: error.message,
      });
    }
  }

  /**
   * Fetches detailed information about a specific server
   * @param {string} mcpId - Server ID to fetch details for
   * @returns {Promise<McpServerDetails>} Server details
   * @throws {MarketplaceError} If fetch fails
   */
  async fetchServerDetails(mcpId) {
    try {
      logger.debug("Fetching server details", { mcpId });
      const response = await fetchWithFallback(`${API_BASE_URL}/download`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mcpId }),
      });

      if (!response.ok) {
        logger.warn("Failed to fetch server details from API, using cache", {
          status: response.status,
          mcpId,
        });
        return this.cache.serverDetails[mcpId]?.data;
      }

      const data = await response.json();
      if (!data?.githubUrl) {
        logger.warn(
          "Invalid API response format for server details, using cache",
          {
            mcpId,
          }
        );
        return this.cache.serverDetails[mcpId]?.data;
      }

      await this.updateServerDetails(mcpId, data);
      return data;
    } catch (error) {
      if (error instanceof MarketplaceError) {
        throw error;
      }
      throw new MarketplaceError("Failed to fetch server details", {
        mcpId,
        error: error.message,
      });
    }
  }

  /**
   * Updates the cached catalog
   * @param {McpMarketplaceItem[]} items - New catalog items
   */
  async updateCatalog(items) {
    this.cache.catalog = {
      items,
      lastUpdated: new Date().toISOString(),
    };
    await this.saveCache();
  }

  /**
   * Updates cached server details
   * @param {string} mcpId - Server ID
   * @param {McpServerDetails} details - Server details
   */
  async updateServerDetails(mcpId, details) {
    this.cache.serverDetails[mcpId] = {
      data: details,
      lastUpdated: new Date().toISOString(),
    };
    await this.saveCache();
  }

  /**
   * Gets the marketplace catalog with optional filtering and sorting
   * @param {MarketplaceQueryOptions} options - Query options
   * @returns {Promise<McpMarketplaceItem[]>} Filtered and sorted items
   */
  async getCatalog(options = {}) {
    if (!this.isCatalogValid()) {
      await this.fetchCatalog();
    }
    return this.queryCatalog(options);
  }

  /**
   * Gets detailed information about a specific server
   * @param {string} mcpId - Server ID
   * @returns {Promise<McpServerDetails|undefined>} Server details
   */
  async getServerDetails(mcpId) {
    if (!this.isServerDetailsValid(mcpId)) {
      await this.fetchServerDetails(mcpId);
    }
    return this.cache.serverDetails[mcpId]?.data;
  }

  /**
   * Filters and sorts marketplace items
   * @param {MarketplaceQueryOptions} options - Query options
   * @returns {McpMarketplaceItem[]} Filtered and sorted items
   */
  queryCatalog({ search, category, tags, sort } = {}) {
    let items = this.cache.catalog.items;

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
        items.sort((a, b) => b.githubStars - a.githubStars);
        break;
      case "name":
        items.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "newest":
      default:
        items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
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


