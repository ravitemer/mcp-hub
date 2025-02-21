import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as server from "../src/server.js";

// Mock process.argv
const originalArgv = process.argv;
const setArgv = (args) => {
  process.argv = ["node", "mcp-hub", ...args];
};

// Mock startServer
vi.mock("../src/server.js", () => ({
  startServer: vi.fn(),
}));

// Mock logger
vi.mock("../src/utils/logger.js", () => ({
  default: {
    error: vi.fn((code, message, data, exit, exitCode) => {
      if (exit) {
        process.exit(exitCode);
      }
    }),
  },
}));

// Mock process.kill
const mockKill = vi.fn();
const mockExit = vi.fn();
process.kill = mockKill;

describe("CLI", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockKill.mockReset();
    mockExit.mockReset();

    // Mock process.exit
    process.exit = mockExit;
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it("should start server with valid arguments", async () => {
    setArgv(["--port", "3000", "--config", "./config.json"]);
    await import("../src/utils/cli.js");

    expect(server.startServer).toHaveBeenCalledWith({
      port: 3000,
      config: "./config.json",
      watch: false,
    });
  });

  it("should start server with watch flag", async () => {
    setArgv(["--port", "3000", "--config", "./config.json", "--watch"]);
    await import("../src/utils/cli.js");

    expect(server.startServer).toHaveBeenCalledWith({
      port: 3000,
      config: "./config.json",
      watch: true,
    });
  });

  it("should handle port flag alias", async () => {
    setArgv(["-p", "3000", "--config", "./config.json"]);
    await import("../src/utils/cli.js");

    expect(server.startServer).toHaveBeenCalledWith({
      port: 3000,
      config: "./config.json",
      watch: false,
    });
  });

  it("should handle config flag alias", async () => {
    setArgv(["--port", "3000", "-c", "./config.json"]);
    await import("../src/utils/cli.js");

    expect(server.startServer).toHaveBeenCalledWith({
      port: 3000,
      config: "./config.json",
      watch: false,
    });
  });

  it("should handle watch flag alias", async () => {
    setArgv(["--port", "3000", "--config", "./config.json", "-w"]);
    await import("../src/utils/cli.js");

    expect(server.startServer).toHaveBeenCalledWith({
      port: 3000,
      config: "./config.json",
      watch: true,
    });
  });

  it("should fail when port is missing", async () => {
    setArgv(["--config", "./config.json"]);
    await import("../src/utils/cli.js");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should fail when config is missing", async () => {
    setArgv(["--port", "3000"]);
    await import("../src/utils/cli.js");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should handle server start errors", async () => {
    const error = new Error("Server start error");
    server.startServer.mockRejectedValueOnce(error);

    setArgv(["--port", "3000", "--config", "./config.json"]);
    await import("../src/utils/cli.js");

    expect(mockKill).toHaveBeenCalledWith(process.pid, "SIGINT");
  });

  it("should handle fatal errors", async () => {
    const fatalError = new Error("Fatal error");
    server.startServer.mockRejectedValueOnce(fatalError);

    setArgv(["--port", "3000", "--config", "./config.json"]);
    await import("../src/utils/cli.js");

    expect(mockKill).toHaveBeenCalledWith(process.pid, "SIGINT");
  });
});
