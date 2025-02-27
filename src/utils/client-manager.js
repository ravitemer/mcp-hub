import logger from "./logger.js";
import { ValidationError } from "./errors.js";

export class ClientManager {
  constructor(shutdownGracePeriodSeconds = 0) {
    this.clients = new Set();
    this.shutdownTimer = null;
    this.shutdownGracePeriodSeconds = shutdownGracePeriodSeconds;
  }

  /**
   * Register a new client
   * @param {string} clientId - Unique identifier for the client
   * @returns {number} Number of active clients
   * @throws {ValidationError} If client is already registered
   */
  registerClient(clientId) {
    if (this.clients.has(clientId)) {
      throw new ValidationError("Client already registered", { clientId });
    }

    logger.info(
      `Client '${clientId}' registered (${
        this.clients.size + 1
      } active clients)`,
      {
        clientId,
        activeClients: this.clients.size + 1,
      }
    );

    this.clients.add(clientId);

    // Clear shutdown timer if it exists
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
      logger.info(`Shutdown cancelled - new client '${clientId}' connected`, {
        clientId,
      });
    }

    return this.clients.size;
  }

  /**
   * Unregister an existing client
   * @param {string} clientId - Unique identifier for the client
   * @returns {number} Number of remaining active clients
   * @throws {ValidationError} If client is not registered
   */
  unregisterClient(clientId) {
    if (!this.clients.has(clientId)) {
      throw new ValidationError("Client not registered", { clientId });
    }

    this.clients.delete(clientId);

    logger.info(
      `Client '${clientId}' unregistered (${this.clients.size} active clients)`,
      {
        clientId,
        activeClients: this.clients.size,
      }
    );

    if (this.clients.size === 0 && !this.shutdownTimer) {
      logger.info(
        `Starting shutdown timer for ${this.shutdownGracePeriodSeconds} seconds - no active clients`,
        {
          graceSeconds: this.shutdownGracePeriodSeconds,
        }
      );

      // Start shutdown timer
      this.shutdownTimer = setTimeout(
        () => this.initiateShutdown(),
        this.shutdownGracePeriodSeconds * 1000
      );
    }

    return this.clients.size;
  }

  /**
   * Check if a client is registered
   * @param {string} clientId - Unique identifier for the client
   * @returns {boolean} True if client is registered
   */
  hasClient(clientId) {
    return this.clients.has(clientId);
  }

  /**
   * Get the count of active clients
   * @returns {number} Number of active clients
   */
  getActiveClientCount() {
    return this.clients.size;
  }

  /**
   * Get all registered client IDs
   * @returns {string[]} Array of client IDs
   */
  getClients() {
    return Array.from(this.clients);
  }

  /**
   * Initiate server shutdown if no clients are connected
   * @private
   */
  initiateShutdown() {
    if (this.clients.size === 0) {
      logger.info(
        `No active clients after ${this.shutdownGracePeriodSeconds} second grace period - initiating shutdown`
      );

      // Reset timer reference
      this.shutdownTimer = null;

      // Output structured shutdown message
      console.log(
        JSON.stringify({
          type: "info",
          code: "CLIENT_SHUTDOWN",
          message: "Shutting down due to no active clients",
          timestamp: new Date().toISOString(),
        })
      );

      // Emit SIGTERM to trigger graceful shutdown
      process.emit("SIGTERM");
    }
  }

  /**
   * Cancel any pending shutdown
   * @returns {boolean} True if shutdown was cancelled
   */
  cancelShutdown() {
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
      logger.info("Automatic shutdown cancelled by manual intervention");
      return true;
    }
    return false;
  }
}
