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
  logger.error(
    "CLI_ARGS_ERROR",
    "Invalid command line arguments",
    {
      message: msg || "Missing required arguments",
      help: "Use --help to see usage information",
      error: err?.message,
    },
    true,
    1
  ); // Add exit:true and exitCode:1
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
      logger.error(error.code, error.message, error.data, true, 1);
    } else if (error.code === "EADDRINUSE") {
      // System errors with known codes get special handling
      logger.error(
        "PORT_IN_USE",
        `Port ${argv.port} is already in use`,
        {
          port: argv.port,
          error: error.message,
        },
        true,
        1
      );
    } else if (error.code === "ENOENT") {
      logger.error(
        "CONFIG_NOT_FOUND",
        `Config file not found: ${argv.config}`,
        {
          path: argv.config,
          error: error.message,
        },
        true,
        1
      );
    } else {
      // For any other error, kill the process
      process.kill(process.pid, "SIGINT");
    }
  }
}

run().catch((error) => {
  // This catch block handles errors from the run() function itself
  // that weren't caught by the try/catch inside run()
  process.kill(process.pid, "SIGINT");
});
