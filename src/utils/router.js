import express from "express";

// Store registered routes for documentation
const routes = [];

// Create router instance
const router = express.Router();

/**
 * Register a route and add it to documentation
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {string} path - Route path
 * @param {string} description - Route description
 * @param {function} handler - Route handler function
 */
function registerRoute(method, path, description, handler) {
  // Add to documentation
  routes.push({
    method,
    path,
    description,
  });

  // Register actual route with error handling wrapper
  router[method.toLowerCase()](path, (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  });
}

/**
 * Generate startup message showing available routes
 * @param {number} port - Server port
 * @param {Object} serverStatuses - Connected server statuses
 * @returns {string}
 */
function generateStartupMessage(port, serverStatuses) {
  const connectedServers = Object.values(serverStatuses).filter(
    (s) => s.status === "connected"
  );

  const message = [
    "\n🚀 MCP Hub Server",
    `Running on http://localhost:${port}`,
    "\nAvailable Routes:",
    ...routes.map(
      (route) =>
        `${route.method.padEnd(6)} ${route.path.padEnd(30)} ${
          route.description
        }`
    ),
    "\nConnected Servers:",
    connectedServers.length === 0
      ? "  No servers connected"
      : connectedServers.map((s) => `  - ${s.name}`).join("\n"),
  ];

  return message.join("\n");
}

export { router, registerRoute, generateStartupMessage };
