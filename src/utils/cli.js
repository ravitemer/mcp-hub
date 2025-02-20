#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { startServer } from "../server.js";
import logger from "./logger.js";

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
    .alias("h", "help").argv;

  try {
    await startServer({
      port: argv.port,
      config: argv.config,
      watch: argv.watch,
    });
  } catch (error) {
    logger.error({
      message: "Failed to start server",
      error: error.message,
    });
    process.kill(process.pid, "SIGINT");
  }
}

run().catch((error) => {
  console.error("Fatal error:", error);
  process.kill(process.pid, "SIGINT");
});
