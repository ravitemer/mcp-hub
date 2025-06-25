/**
 * OAuth provider for MCP Hub that manages authorization flow and token storage
 * Implements the OAuth client interface required by the MCP SDK
 */
import logger from "./logger.js";
import fs from 'fs/promises';
import path from 'path';
import { getDataDirectory } from "./xdg-paths.js";

// File level storage
let serversStorage = {};

class StorageManager {
  constructor() {
    this.path = path.join(getDataDirectory(), 'oauth-storage.json');
  }

  async init() {
    try {
      await fs.mkdir(path.dirname(this.path), { recursive: true });
      try {
        const data = await fs.readFile(this.path, 'utf8');
        serversStorage = JSON.parse(data);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger.warn(`Error reading storage: ${err.message}`);
        }
      }
    } catch (err) {
      logger.warn(`Storage initialization error: ${err.message}`);
    }
  }

  async save() {
    try {
      await fs.writeFile(this.path, JSON.stringify(serversStorage, null, 2), 'utf8');
    } catch (err) {
      logger.warn(`Error saving storage: ${err.message}`);
    }
  }

  get(serverUrl) {
    if (!serversStorage[serverUrl]) {
      serversStorage[serverUrl] = { clientInfo: null, tokens: null, codeVerifier: null };
    }
    return serversStorage[serverUrl];
  }

  async update(serverUrl, data) {
    const serverData = this.get(serverUrl);
    serversStorage[serverUrl] = { ...serverData, ...data };
    return this.save();
  }
}

// Singleton instance
const storage = new StorageManager();

// Initialize storage once
storage.init();

export default class MCPHubOAuthProvider {
  constructor({ serverName, serverUrl, hubServerUrl }) {
    this.serverName = serverName;
    this.serverUrl = serverUrl;
    this.hubServerUrl = hubServerUrl;
    this.generatedAuthUrl = null;
  }

  get redirectUrl() {
    const callbackURL = new URL("/api/oauth/callback", this.hubServerUrl);
    callbackURL.searchParams.append("server_name", this.serverName);
    return callbackURL.toString();
  }

  get clientMetadata() {
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "MCP Hub",
      client_uri: "https://github.com/ravitemer/mcp-hub",
    };
  }

  async clientInformation() {
    const data = storage.get(this.serverUrl);
    logger.file(`[${this.serverName}] Getting client information`);
    return data.clientInfo;
  }

  async saveClientInformation(info) {
    logger.file(`[${this.serverName}] Saving client information`);
    return storage.update(this.serverUrl, { clientInfo: info });
  }

  async tokens() {
    return storage.get(this.serverUrl).tokens;
  }

  async saveTokens(tokens) {
    logger.file(`[${this.serverName}] Saving tokens`);
    return storage.update(this.serverUrl, { tokens });
  }

  async redirectToAuthorization(authUrl) {
    logger.file(`[${this.serverName}] Redirecting to authorization`);
    this.generatedAuthUrl = authUrl;
    return true;
  }

  async saveCodeVerifier(verifier) {
    logger.file(`[${this.serverName}] Saving code verifier`);
    return storage.update(this.serverUrl, { codeVerifier: verifier });
  }

  async codeVerifier() {
    logger.file(`[${this.serverName}] Getting Code verifier`);
    return storage.get(this.serverUrl).codeVerifier;
  }
}
