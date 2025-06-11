import { describe, it, expect, vi, beforeEach } from "vitest";
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

    it("should export singleton instance", () => {
      expect(envResolver).toBeInstanceOf(EnvResolver);
    });
  });

  describe("String Placeholder Resolution", () => {
    it("should resolve simple environment variables", async () => {
      const context = { TEST_VAR: 'resolved_value', API_KEY: 'secret' };

      const result = await resolver._resolveStringWithPlaceholders("${TEST_VAR}", context);
      expect(result).toBe("resolved_value");

      const result2 = await resolver._resolveStringWithPlaceholders("Bearer ${API_KEY}", context);
      expect(result2).toBe("Bearer secret");
    });

    it("should handle multiple placeholders in one string", async () => {
      const context = { HOST: 'localhost', PORT: '3000', DB: 'myapp' };

      const result = await resolver._resolveStringWithPlaceholders(
        "postgresql://${HOST}:${PORT}/${DB}",
        context
      );
      expect(result).toBe("postgresql://localhost:3000/myapp");
    });

    it("should keep unresolved placeholders intact", async () => {
      const context = { KNOWN_VAR: 'known' };

      const result = await resolver._resolveStringWithPlaceholders(
        "${KNOWN_VAR} and ${UNKNOWN_VAR}",
        context
      );
      expect(result).toBe("known and ${UNKNOWN_VAR}");
    });

    it("should execute commands in placeholders", async () => {
      mockExecPromise.mockResolvedValueOnce({ stdout: "secret_value\n" });
      const context = {};

      const result = await resolver._resolveStringWithPlaceholders(
        "Bearer ${cmd: op read secret}",
        context
      );

      expect(mockExecPromise).toHaveBeenCalledWith(
        "op read secret",
        expect.objectContaining({ timeout: 30000 })
      );
      expect(result).toBe("Bearer secret_value");
    });

    it("should handle mixed environment variables and commands", async () => {
      mockExecPromise.mockResolvedValueOnce({ stdout: "cmd_result\n" });
      const context = { ENV_VAR: 'env_value' };

      const result = await resolver._resolveStringWithPlaceholders(
        "${ENV_VAR}-${cmd: echo test}",
        context
      );

      expect(result).toBe("env_value-cmd_result");
    });
  });

  describe("Command Execution", () => {
    it("should execute legacy $: commands", async () => {
      mockExecPromise.mockResolvedValueOnce({ stdout: "command_output\n" });

      const result = await resolver._executeCommand("$: echo hello");

      expect(mockExecPromise).toHaveBeenCalledWith(
        "echo hello",
        expect.objectContaining({ timeout: 30000, encoding: 'utf8' })
      );
      expect(result).toBe("command_output");
    });

    it("should execute new ${cmd: ...} commands", async () => {
      mockExecPromise.mockResolvedValueOnce({ stdout: "secret_value\n" });

      const result = await resolver._executeCommand("${cmd: op read secret}");

      expect(mockExecPromise).toHaveBeenCalledWith(
        "op read secret",
        expect.objectContaining({ timeout: 30000, encoding: 'utf8' })
      );
      expect(result).toBe("secret_value");
    });

    it("should handle command execution errors", async () => {
      const error = new Error("Command failed");
      mockExecPromise.mockRejectedValueOnce(error);

      await expect(resolver._executeCommand("$: failing-command"))
        .rejects.toThrow("Command failed");
    });
  });

  describe("Configuration Resolution", () => {
    it("should resolve env field with null fallbacks", async () => {
      const config = {
        env: {
          SIMPLE_VAR: "${TEST_VAR}",
          FALLBACK_VAR: null,
          STATIC_VAR: "static_value"
        }
      };

      const result = await resolver.resolveConfig(config, ['env']);

      expect(result.env.SIMPLE_VAR).toBe('test_value');
      expect(result.env.FALLBACK_VAR).toBe(''); // null falls back to empty
      expect(result.env.STATIC_VAR).toBe('static_value');
    });

    it("should resolve args field with legacy syntax", async () => {
      const config = {
        env: { TOKEN: 'secret123' },
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

    it("should resolve headers field", async () => {
      mockExecPromise.mockResolvedValueOnce({ stdout: "auth_token\n" });

      const config = {
        headers: {
          "Authorization": "Bearer ${cmd: get-token}",
          "X-Custom": "${API_KEY}",
          "Static": "value"
        }
      };

      const result = await resolver.resolveConfig(config, ['headers']);

      expect(result.headers).toEqual({
        "Authorization": "Bearer auth_token",
        "X-Custom": "secret_key",
        "Static": "value"
      });
    });

    it("should resolve url and command fields", async () => {
      const config = {
        url: "https://${API_KEY}.example.com",
        command: "${TEST_VAR}/bin/server"
      };

      const result = await resolver.resolveConfig(config, ['url', 'command']);

      expect(result.url).toBe("https://secret_key.example.com");
      expect(result.command).toBe("test_value/bin/server");
    });

    it("should handle multi-pass resolution in env", async () => {
      const config = {
        env: {
          FIRST: "value1",
          SECOND: "${FIRST}_extended",
          THIRD: "${SECOND}_final"
        }
      };

      const result = await resolver.resolveConfig(config, ['env']);

      expect(result.env.FIRST).toBe('value1');
      expect(result.env.SECOND).toBe('value1_extended');
      expect(result.env.THIRD).toBe('value1_extended_final');
    });

    it("should handle commands in env providing context for other fields", async () => {
      mockExecPromise.mockResolvedValueOnce({ stdout: "secret_from_cmd\n" });

      const config = {
        env: {
          SECRET: "${cmd: get-secret}"
        },
        headers: {
          "Authorization": "Bearer ${SECRET}"
        }
      };

      const result = await resolver.resolveConfig(config, ['env', 'headers']);

      expect(result.env.SECRET).toBe('secret_from_cmd');
      expect(result.headers.Authorization).toBe('Bearer secret_from_cmd');
    });

    it("should work without env field for remote servers", async () => {
      mockExecPromise.mockResolvedValueOnce({ stdout: "remote_token\n" });

      const config = {
        url: "https://api.example.com",
        headers: {
          "Authorization": "Bearer ${cmd: get-remote-token}"
        }
      };

      const result = await resolver.resolveConfig(config, ['url', 'headers']);

      expect(result.url).toBe('https://api.example.com');
      expect(result.headers.Authorization).toBe('Bearer remote_token');
    });

    it("should handle circular dependencies gracefully", async () => {
      const config = {
        env: {
          VAR_A: "${VAR_B}",
          VAR_B: "${VAR_A}"
        }
      };

      const result = await resolver.resolveConfig(config, ['env']);

      // Should fallback to original values when circular dependency detected
      expect(result.env.VAR_A).toBe('${VAR_B}');
      expect(result.env.VAR_B).toBe('${VAR_A}');
    });
  });

  describe("Error Handling", () => {
    it("should handle command execution failures gracefully", async () => {
      mockExecPromise.mockRejectedValueOnce(new Error("Command failed"));

      const config = {
        headers: {
          "Authorization": "Bearer ${cmd: failing-command}"
        }
      };

      const result = await resolver.resolveConfig(config, ['headers']);

      // Should keep original placeholder on command failure
      expect(result.headers.Authorization).toBe('Bearer ${cmd: failing-command}');
    });

    it("should handle non-string values gracefully", async () => {
      const config = {
        env: {
          NUMBER: 123,
          BOOLEAN: true,
          NULL_VAL: null
        },
        args: ["string", 456, true]
      };

      const result = await resolver.resolveConfig(config, ['env', 'args']);

      expect(result.env.NUMBER).toBe(123);
      expect(result.env.BOOLEAN).toBe(true);
      expect(result.env.NULL_VAL).toBe('');
      expect(result.args).toEqual(["string", 456, true]);
    });
  });
});
