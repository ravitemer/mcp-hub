import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Marketplace, getMarketplace } from "../src/marketplace.js";
import fs from "fs/promises";
import path from "path";
import os from "os";

// Mock global fetch
global.fetch = vi.fn();

// Mock sample data
const sampleCatalog = [
  {
    mcpId: "github.com/test/server1",
    name: "Test Server 1",
    description: "A test server",
    category: "test",
    tags: ["test", "example"],
    githubStars: 100,
    createdAt: "2024-01-01T00:00:00Z",
  },
  {
    mcpId: "github.com/test/server2",
    name: "Sample Server",
    description: "Another test server",
    category: "sample",
    tags: ["sample", "example"],
    githubStars: 50,
    createdAt: "2024-02-01T00:00:00Z",
  },
];

const sampleServerDetails = {
  mcpId: "github.com/test/server1",
  name: "Test Server 1",
  description: "A test server",
  githubUrl: "https://github.com/test/server1",
  readmeContent: "# Test Server\nThis is a test server.",
};

describe("Marketplace", () => {
  let marketplace;
  let mockCacheDir;

  beforeEach(async () => {
    // Setup mock cache directory
    mockCacheDir = path.join(os.tmpdir(), ".mcp-hub-test", "cache");
    await fs.mkdir(mockCacheDir, { recursive: true });

    // Create marketplace instance with test config
    marketplace = new Marketplace(1000); // 1 second TTL for testing
    marketplace.cacheFile = path.join(mockCacheDir, "marketplace.json");

    // Reset fetch mock
    fetch.mockReset();
  });

  afterEach(async () => {
    // Cleanup mock cache directory
    await fs.rm(mockCacheDir, { recursive: true, force: true });
  });

  describe("getCatalog", () => {
    it("should fetch and cache catalog when cache is empty", async () => {
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => sampleCatalog,
      });

      const result = await marketplace.getCatalog();

      expect(result).toHaveLength(2);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        "https://api.cline.bot/v1/mcp/marketplace"
      );

      // Verify cache was written
      const cacheContent = JSON.parse(
        await fs.readFile(marketplace.cacheFile, "utf-8")
      );
      expect(cacheContent.catalog.items).toHaveLength(2);
    });

    it("should use cached catalog when valid", async () => {
      // First call to populate cache
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => sampleCatalog,
      });
      await marketplace.getCatalog();

      // Second call should use cache
      const result = await marketplace.getCatalog();

      expect(result).toHaveLength(2);
      expect(fetch).toHaveBeenCalledTimes(1); // Only called once
    });

    it("should handle search filter", async () => {
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => sampleCatalog,
      });

      const result = await marketplace.getCatalog({ search: "sample" });

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Sample Server");
    });

    it("should handle category filter", async () => {
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => sampleCatalog,
      });

      const result = await marketplace.getCatalog({ category: "test" });

      expect(result).toHaveLength(1);
      expect(result[0].category).toBe("test");
    });

    it("should handle sorting", async () => {
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => sampleCatalog,
      });

      const result = await marketplace.getCatalog({ sort: "stars" });

      expect(result).toHaveLength(2);
      expect(result[0].githubStars).toBe(100);
      expect(result[1].githubStars).toBe(50);
    });
  });

  describe("getServerDetails", () => {
    it("should fetch and cache server details", async () => {
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => sampleServerDetails,
      });

      const result = await marketplace.getServerDetails(
        "github.com/test/server1"
      );

      expect(result).toEqual(sampleServerDetails);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        "https://api.cline.bot/v1/mcp/download",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mcpId: "github.com/test/server1" }),
        }
      );

      // Verify cache was written
      const cacheContent = JSON.parse(
        await fs.readFile(marketplace.cacheFile, "utf-8")
      );
      expect(
        cacheContent.serverDetails["github.com/test/server1"].data
      ).toEqual(sampleServerDetails);
    });

    it("should use cached server details when valid", async () => {
      // First call to populate cache
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => sampleServerDetails,
      });
      await marketplace.getServerDetails("github.com/test/server1");

      // Second call should use cache
      const result = await marketplace.getServerDetails(
        "github.com/test/server1"
      );

      expect(result).toEqual(sampleServerDetails);
      expect(fetch).toHaveBeenCalledTimes(1); // Only called once
    });
  });

  describe("error handling", () => {
    it("should handle network errors", async () => {
      fetch.mockRejectedValueOnce(new Error("Network error"));

      await expect(marketplace.getCatalog()).rejects.toThrow(
        "Failed to fetch marketplace catalog"
      );
    });

    it("should handle invalid API responses", async () => {
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => null,
      });

      await expect(marketplace.getCatalog()).rejects.toThrow(
        "Invalid response format from marketplace API"
      );
    });

    it("should handle HTTP errors", async () => {
      fetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(marketplace.getCatalog()).rejects.toThrow(
        "HTTP error! status: 404"
      );
    });
  });

  describe("singleton", () => {
    it("should return the same instance", () => {
      const instance1 = getMarketplace();
      const instance2 = getMarketplace();

      expect(instance1).toBe(instance2);
    });

    it("should respect custom TTL", () => {
      const instance = getMarketplace(2000);
      expect(instance.ttl).toBe(2000);
    });
  });
});
