import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EnvResolver, envResolver } from "../src/utils/env-resolver.js";
import { exec } from 'child_process';
import { promisify } from 'util';

// Mock child_process and util together
let mockExecPromise;

vi.mock('child_process', () => ({
  exec: vi.fn()
}));

vi.mock('util', () => ({
  promisify: vi.fn().mockImplementation(() => {
    // Return the mock that will be set in beforeEach
    return (...args) => mockExecPromise(...args);
  })
}));

// Mock logger
vi.mock("../src/utils/logger.js", () => ({
  default: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe("EnvResolver", () => {
  let resolver;
  let originalProcessEnv;

  beforeEach(() => {
    vi.clearAllMocks();

    // Store original process.env
    originalProcessEnv = process.env;

    // Setup fresh process.env for each test
    process.env = {
      NODE_ENV: 'test',
      TEST_VAR: 'test_value',
      API_KEY: 'secret_key',
      DATABASE_URL: 'postgres://localhost:5432/test'
    };

    // Setup exec mock
    mockExecPromise = vi.fn();
    promisify.mockReturnValue(mockExecPromise);

    // Create new resolver instance
    resolver = new EnvResolver();
  });

  afterEach(() => {
    // Restore original process.env
    process.env = originalProcessEnv;
  });

  describe("Constructor and Basic Setup", () => {
    it("should initialize with default options", () => {
      const newResolver = new EnvResolver();
      expect(newResolver.maxPasses).toBe(10);
      expect(newResolver.commandTimeout).toBe(30000);
    });

    it("should initialize with custom options", () => {
      const customResolver = new EnvResolver({
        maxPasses: 5,
        commandTimeout: 10000
      });
      expect(customResolver.maxPasses).toBe(5);
      expect(customResolver.commandTimeout).toBe(10000);
    });

    it("should export singleton instance", () => {
      expect(envResolver).toBeInstanceOf(EnvResolver);
    });
  });

  describe("Command Detection", () => {
    it("should detect legacy $: command syntax", () => {
      expect(resolver._isCommand("$: echo hello")).toBe(true);
      expect(resolver._isCommand("$:echo hello")).toBe(true);
      expect(resolver._isCommand("$: op read secret")).toBe(true);
    });

    it("should detect new ${cmd: ...} command syntax", () => {
      expect(resolver._isCommand("${cmd: echo hello}")).toBe(true);
      expect(resolver._isCommand("${cmd:echo hello}")).toBe(true);
      expect(resolver._isCommand("${cmd: op read secret}")).toBe(true);
    });

    it("should not detect invalid command syntax", () => {
      expect(resolver._isCommand("${cmd: incomplete")).toBe(false);
      expect(resolver._isCommand("${ENV_VAR}")).toBe(false);
      expect(resolver._isCommand("normal string")).toBe(false);
      expect(resolver._isCommand("$ENV_VAR")).toBe(false);
    });

    it("should handle non-string values", () => {
      expect(resolver._isCommand(null)).toBe(false);
      expect(resolver._isCommand(undefined)).toBe(false);
      expect(resolver._isCommand(123)).toBe(false);
      expect(resolver._isCommand({})).toBe(false);
    });
  });

  describe("Placeholder Resolution", () => {
    it("should resolve simple environment variables", () => {
      const context = { TEST_VAR: 'resolved_value', API_KEY: 'secret' };

      const result = resolver._resolvePlaceholders("${TEST_VAR}", context);
      expect(result).toBe("resolved_value");

      const result2 = resolver._resolvePlaceholders("Bearer ${API_KEY}", context);
      expect(result2).toBe("Bearer secret");
    });

    it("should handle multiple placeholders in one string", () => {
      const context = { HOST: 'localhost', PORT: '3000', DB: 'myapp' };

      const result = resolver._resolvePlaceholders(
        "postgresql://${HOST}:${PORT}/${DB}",
        context
      );
      expect(result).toBe("postgresql://localhost:3000/myapp");
    });

    it("should keep unresolved placeholders intact", () => {
      const context = { KNOWN_VAR: 'known' };

      const result = resolver._resolvePlaceholders(
        "${KNOWN_VAR} and ${UNKNOWN_VAR}",
        context
      );
      expect(result).toBe("known and ${UNKNOWN_VAR}");
    });

    it("should handle non-string values", () => {
      const context = {};

      expect(resolver._resolvePlaceholders(null, context)).toBe(null);
      expect(resolver._resolvePlaceholders(123, context)).toBe(123);
      expect(resolver._resolvePlaceholders({}, context)).toEqual({});
    });
  });

  describe("Command Execution", () => {
    it("should execute legacy $: commands", async () => {
      mockExecPromise.mockResolvedValueOnce({
        stdout: "command_output\n"
      });

      const result = await resolver._executeCommand("$: echo hello");

      expect(mockExecPromise).toHaveBeenCalledWith(
        "echo hello",
        expect.objectContaining({
          timeout: 30000,
          encoding: 'utf8'
        })
      );
      expect(result).toBe("command_output");
    });

    it("should execute new ${cmd: ...} commands", async () => {
      mockExecPromise.mockResolvedValueOnce({
        stdout: "secret_value\n"
      });

      const result = await resolver._executeCommand("${cmd: op read secret}");

      expect(mockExecPromise).toHaveBeenCalledWith(
        "op read secret",
        expect.objectContaining({
          timeout: 30000,
          encoding: 'utf8'
        })
      );
      expect(result).toBe("secret_value");
    });

    it("should handle command execution errors", async () => {
      const error = new Error("Command failed");
      mockExecPromise.mockRejectedValueOnce(error);

      await expect(resolver._executeCommand("$: failing-command"))
        .rejects.toThrow("Command failed");
    });

    it("should throw error for invalid command syntax", async () => {
      await expect(resolver._executeCommand("${cmd: incomplete"))
        .rejects.toThrow("Invalid command syntax");
    });
  });

  describe("Basic Integration Tests", () => {
    it("should resolve config with env field", async () => {
      const config = {
        env: {
          SIMPLE_VAR: "${TEST_VAR}",
          FALLBACK_VAR: null,  // Should fallback to process.env.FALLBACK_VAR (empty)
          API_KEY_FALLBACK: null,  // Should fallback to process.env.API_KEY_FALLBACK -> process.env.API_KEY
          STATIC_VAR: "static_value"
        }
      };

      // Add a variable that exists in process.env for fallback test
      process.env.API_KEY_FALLBACK = process.env.API_KEY;

      const result = await resolver.resolveConfig(config, ['env']);

      expect(result.env.SIMPLE_VAR).toBe('test_value');  // Resolved ${TEST_VAR}
      expect(result.env.FALLBACK_VAR).toBe(''); // Falls back to process.env.FALLBACK_VAR (doesn't exist)
      expect(result.env.API_KEY_FALLBACK).toBe('secret_key'); // Falls back to process.env.API_KEY_FALLBACK
      expect(result.env.STATIC_VAR).toBe('static_value'); // Static value
    });

    it("should resolve config with args field", async () => {
      const config = {
        env: {
          TOKEN: 'secret123'
        },
        args: [
          "--token", "${TOKEN}",
          "--legacy", "$API_KEY",  // Legacy syntax
          "--static", "value"
        ]
      };

      const result = await resolver.resolveConfig(config, ['env', 'args']);

      expect(result.args).toEqual([
        "--token", "secret123",
        "--legacy", "secret_key",  // From process.env.API_KEY
        "--static", "value"
      ]);
    });

    it("should resolve config with command execution", async () => {
      mockExecPromise.mockResolvedValueOnce({ stdout: "executed_secret\n" });

      const config = {
        env: {
          SECRET: "${cmd: op read secret}",
          COMBINED: "prefix-${SECRET}-suffix"
        }
      };

      const result = await resolver.resolveConfig(config, ['env']);

      expect(mockExecPromise).toHaveBeenCalledWith(
        "op read secret",
        expect.objectContaining({ timeout: 30000 })
      );
      expect(result.env.SECRET).toBe('executed_secret');
      expect(result.env.COMBINED).toBe('prefix-executed_secret-suffix');
    });
  });
});
