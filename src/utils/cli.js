#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { startServer } from "../server.js";
import logger from "./logger.js";
import { readFileSync } from 'fs';
import {
  isMCPHubError,
} from "./errors.js";
import { fileURLToPath } from "url";
import { join } from "path";

// VERSION will be injected from package.json during build
/* global process.env.VERSION */


// Read version from package.json while in dev mode to get the latest version
// We can't do this production, due to issues when installed as global package on "bun"
// Ignore the esbuild build warning id: 'assign-to-define',
if (process.env.NODE_ENV != "production") {
  // Get the directory path of the current module
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  // Navigate up two directories to find package.json
  const pkgPath = join(__dirname, '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const version = pkg.version;
  process.env.VERSION = version;
}

// Custom failure handler for yargs
function handleParseError(msg, err) {
  // Ensure CLI parsing errors exit immediately with proper code
  logger.error(
    "CLI_ARGS_ERROR",
    "Failed to parse command line arguments",
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
    .version(process.env.VERSION || "v0.0.0")
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
      "auto-shutdown": {
        describe: "Whether to automatically shutdown when no clients are connected",
        type: "boolean",
        default: false
      },
      "shutdown-delay": {
        describe:
          "Delay in milliseconds before shutting down when auto-shutdown is enabled and no clients are connected",
        type: "number",
        default: 0,
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
      autoShutdown: argv["auto-shutdown"],
      shutdownDelay: argv["shutdown-delay"],
    });
  } catch (error) {
    process.exit(1)
  }
}

run()
