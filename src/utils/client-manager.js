import logger from "./logger.js";

export class ClientManager {
  constructor() {
    this.clients = new Set();
    this.shutdownTimer = null;
  }

  /**
   * Register a new client
   * @param {string} clientId - Unique identifier for the client
   * @returns {number} Number of active clients
   */
  registerClient(clientId) {
    logger.info({
      message: "Client registered",
      clientId,
      activeClients: this.clients.size + 1,
    });

    this.clients.add(clientId);

    // Clear shutdown timer if it exists
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
      logger.info({
        message: "Shutdown cancelled due to new client",
        clientId,
      });
    }

    return this.clients.size;
  }

  /**
   * Unregister an existing client
   * @param {string} clientId - Unique identifier for the client
   * @returns {number} Number of remaining active clients
   */
  unregisterClient(clientId) {
    this.clients.delete(clientId);

    logger.info({
      message: "Client unregistered",
      clientId,
      activeClients: this.clients.size,
    });

    if (this.clients.size === 0 && !this.shutdownTimer) {
      logger.info({
        message: "Starting shutdown timer - no active clients",
        graceSeconds: 5,
      });

      // Start shutdown timer
      this.shutdownTimer = setTimeout(() => this.initiateShutdown(), 5000);
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
      logger.info({
        message: "No active clients after grace period, initiating shutdown",
      });

      // Reset timer reference
      this.shutdownTimer = null;

      // Output structured shutdown message
      console.log(
        JSON.stringify({
          status: "shutting_down",
          reason: "no_active_clients",
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
      logger.info({
        message: "Shutdown cancelled manually",
      });
      return true;
    }
    return false;
  }
}
