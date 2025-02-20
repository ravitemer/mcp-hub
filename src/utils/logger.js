import winston from "winston";
import path from "path";
import os from "os";

// Ensure log directory exists
const LOG_DIR = path.join(os.homedir(), ".mcp-hub", "logs");
await import("fs/promises").then((fs) =>
  fs.mkdir(LOG_DIR, { recursive: true })
);

const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    // File transport for all logs
    new winston.transports.File({
      filename: path.join(LOG_DIR, "mcp-hub.log"),
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
    }),
    // Console transport only for errors
    new winston.transports.Console({
      level: "error",
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
  // Don't exit on error
  exitOnError: false,
});

// Special handling for startup/shutdown messages
const originalInfo = logger.info;
logger.info = (info) => {
  // If it's a startup or shutdown message, also log to console as JSON
  if (
    typeof info === "object" &&
    (info.message?.includes("Starting HTTP server") ||
      info.message?.includes("Initializing MCP Hub") ||
      info.message?.includes("Shutting down") ||
      info.status === "ready" ||
      info.status === "shutting_down")
  ) {
    console.log(JSON.stringify(info));
  }
  return originalInfo.call(logger, info);
};

// Capture unhandled errors
process.on("uncaughtException", (error) => {
  logger.error({
    message: "Uncaught exception",
    error: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString(),
  });
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  logger.error({
    message: "Unhandled rejection",
    error: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString(),
  });
});

export default logger;
