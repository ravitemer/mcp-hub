#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { startServer } from "../server.js";
import logger from "./logger.js";
import {
  ValidationError,
  ServerError,
  ConfigError,
  isMCPHubError,
} from "./errors.js";

// Custom failure handler for yargs
function handleParseError(msg, err) {
  // Ensure CLI parsing errors exit immediately with proper code
  logger.error("CLI_ARGS_ERROR", "Invalid command line arguments", {
    message: msg || "Missing required arguments",
    help: "Use --help to see usage information",
    error: err?.message,
  });
}

async function run() {
  const argv = yargs(hideBin(process.argv))
    .usage("Usage: mcp-hub [options]")
    .options({
      port: {
        alias: "p",
        describe: "Port to run the server on",
        type: "number",
        demandOption: true,
      },
      config: {
        alias: "c",
        describe: "Path to config file",
        type: "string",
        demandOption: true,
      },
      watch: {
        alias: "w",
        describe: "Watch for config file changes",
        type: "boolean",
        default: false,
      },
    })
    .example("mcp-hub --port 3000 --config ./mcp-servers.json")
    .help("h")
    .alias("h", "help")
    .fail(handleParseError).argv;

  try {
    await startServer({
      port: argv.port,
      config: argv.config,
      watch: argv.watch,
    });
  } catch (error) {
    if (isMCPHubError(error)) {
      // Our errors are already structured, just pass them through
      logger.error(error.code, error.message, error.data);
    } else if (error.code === "EADDRINUSE") {
      // System errors with known codes get special handling
      logger.error("PORT_IN_USE", `Port ${argv.port} is already in use`, {
        port: argv.port,
        error: error.message,
      });
    } else if (error.code === "ENOENT") {
      logger.error(
        "CONFIG_NOT_FOUND",
        `Config file not found: ${argv.config}`,
        {
          path: argv.config,
          error: error.message,
        }
      );
    } else {
      // Unexpected errors exit with code 1
      logger.error(
        "UNEXPECTED_ERROR",
        "An unexpected error occurred while starting the server",
        {
          error: error.message,
          stack: error.stack,
        },
        true,
        1
      );
    }
  }
}

run().catch((error) => {
  // This catch block handles errors from the run() function itself
  // that weren't caught by the try/catch inside run()
  logger.error(
    "FATAL_ERROR",
    "A fatal error occurred in the CLI",
    {
      error: error.message,
      stack: error.stack,
    },
    true,
    1
  );
});
