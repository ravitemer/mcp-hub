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
      expect(newResolver.strict).toBe(true); // Default to strict mode
    });

    it("should allow disabling strict mode", () => {
      const newResolver = new EnvResolver({ strict: false });
      expect(newResolver.strict).toBe(false);
    });

    it("should export singleton instance with strict mode enabled", () => {
      expect(envResolver).toBeInstanceOf(EnvResolver);
      expect(envResolver.strict).toBe(true);
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

    it("should keep unresolved placeholders intact in non-strict mode", async () => {
      const nonStrictResolver = new EnvResolver({ strict: false });
      const context = { KNOWN_VAR: 'known' };

      const result = await nonStrictResolver._resolveStringWithPlaceholders(
        "${KNOWN_VAR} and ${UNKNOWN_VAR}",
        context
      );
      expect(result).toBe("known and ${UNKNOWN_VAR}");
    });

    it("should throw error on unresolved placeholders in strict mode", async () => {
      const context = { KNOWN_VAR: 'known' };

      await expect(resolver._resolveStringWithPlaceholders(
        "${KNOWN_VAR} and ${UNKNOWN_VAR}",
        context
      )).rejects.toThrow("Variable 'UNKNOWN_VAR' not found");
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

  describe("Nested Placeholder Resolution", () => {
    it("should resolve nested environment variables inside command placeholders", async () => {
      mockExecPromise.mockResolvedValueOnce({ stdout: "nested_cmd_result\n" });
      const context = {
        COMMAND: "echo",
        ARGUMENT: "nested_cmd_result"
      };

      const result = await resolver._resolveStringWithPlaceholders(
        "Data: ${cmd: ${COMMAND} ${ARGUMENT}}",
        context
      );

      expect(mockExecPromise).toHaveBeenCalledWith(
        "echo nested_cmd_result",
        expect.any(Object)
      );
      expect(result).toBe("Data: nested_cmd_result");
    });

    it("should handle complex nested command and variable placeholders", async () => {
      mockExecPromise.mockResolvedValueOnce({ stdout: "obsidian-token" });
      const context = {
        TEST: 'hello',
        XDG_RUNTIME_DIR: '/run/user/1000'
      };

      const result = await resolver._resolveStringWithPlaceholders(
        "TOKEN ${TEST} ${cmd: cat ${XDG_RUNTIME_DIR}/agenix/mcp-obsidian-token} ${TEST}",
        context
      );

      expect(mockExecPromise).toHaveBeenCalledWith(
        "cat /run/user/1000/agenix/mcp-obsidian-token",
        expect.any(Object)
      );
      expect(result).toBe("TOKEN hello obsidian-token hello");
    });

    it("should throw error on unresolved nested placeholders in strict mode", async () => {
      const context = {
        KNOWN_VAR: 'known'
      };

      await expect(resolver._resolveStringWithPlaceholders(
        "Data: ${cmd: echo ${UNKNOWN_VAR}}",
        context
      )).rejects.toThrow("Variable 'UNKNOWN_VAR' not found");
    });

    it("should keep unresolved nested placeholders in non-strict mode by executing command with literal", async () => {
      const nonStrictResolver = new EnvResolver({ strict: false });
      const context = { KNOWN_VAR: 'known' };
      mockExecPromise.mockResolvedValueOnce({ stdout: "${UNKNOWN_VAR}\n" });

      const result = await nonStrictResolver._resolveStringWithPlaceholders(
        "Data: ${cmd: echo ${UNKNOWN_VAR}} and ${KNOWN_VAR}",
        context
      );

      expect(mockExecPromise).toHaveBeenCalledWith(
        "echo ${UNKNOWN_VAR}",
        expect.any(Object)
      );
      expect(result).toBe("Data: ${UNKNOWN_VAR} and known");
    });
  });

  describe("Command Execution", () => {
    describe("Command Execution", () => {
      it("should execute ${cmd: ...} commands via _executeCommand", async () => {
        mockExecPromise.mockResolvedValueOnce({ stdout: "secret_value\n" });

        const result = await resolver._executeCommand("${cmd: op read secret}");

        expect(mockExecPromise).toHaveBeenCalledWith(
          "op read secret",
          expect.objectContaining({ timeout: 30000, encoding: 'utf8' })
        );
        expect(result).toBe("secret_value");
      });

      it("should execute command content directly via _executeCommandContent", async () => {
        mockExecPromise.mockResolvedValueOnce({ stdout: "direct_result\n" });

        const result = await resolver._executeCommandContent("cmd: echo direct");

        expect(mockExecPromise).toHaveBeenCalledWith(
          "echo direct",
          expect.objectContaining({ timeout: 30000, encoding: 'utf8' })
        );
        expect(result).toBe("direct_result");
      });

      it("should handle command execution errors", async () => {
        const error = new Error("Command failed");
        mockExecPromise.mockRejectedValueOnce(error);

        await expect(resolver._executeCommand("${cmd: failing-command}"))
          .rejects.toThrow("Command failed");
      });

      it("should handle empty commands", async () => {
        await expect(resolver._executeCommand("${cmd: }"))
          .rejects.toThrow("Empty command in cmd:");

        await expect(resolver._executeCommandContent("cmd: "))
          .rejects.toThrow("Empty command in cmd:");
      });

      it("should support legacy $: syntax with deprecation warning", async () => {
        mockExecPromise.mockResolvedValueOnce({ stdout: "legacy_output\n" });

        const result = await resolver._executeCommand("$: echo legacy");

        expect(mockExecPromise).toHaveBeenCalledWith(
          "echo legacy",
          expect.objectContaining({ timeout: 30000, encoding: 'utf8' })
        );
        expect(result).toBe("legacy_output");
      });

      it("should throw error for invalid command syntax", async () => {
        await expect(resolver._executeCommand("invalid: command"))
          .rejects.toThrow("Invalid command syntax: invalid: command");
      });
    });

    describe("Configuration Resolution", () => {
      it("should resolve env field with null fallbacks", async () => {
        // Set a variable in process.env that can be used as fallback
        process.env.FALLBACK_VAR = 'fallback_value';

        const config = {
          env: {
            SIMPLE_VAR: "${TEST_VAR}",
            FALLBACK_VAR: null,
            STATIC_VAR: "static_value"
          }
        };

        const result = await resolver.resolveConfig(config, ['env']);

        expect(result.env.SIMPLE_VAR).toBe('test_value');
        expect(result.env.FALLBACK_VAR).toBe('fallback_value'); // null falls back to process.env
        expect(result.env.STATIC_VAR).toBe('static_value');

        // Cleanup
        delete process.env.FALLBACK_VAR;
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

      it("should resolve env field with placeholders", async () => {
        // Set up context variables
        process.env.FIRST = "value1";

        const config = {
          env: {
            FIRST: "value1",
            SECOND: "${FIRST}_extended"
          }
        };

        const result = await resolver.resolveConfig(config, ['env']);

        expect(result.env.FIRST).toBe('value1');
        expect(result.env.SECOND).toBe('value1_extended'); // Uses process.env.FIRST

        // Cleanup
        delete process.env.FIRST;
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

      it("should handle circular dependencies gracefully in non-strict mode", async () => {
        const nonStrictResolver = new EnvResolver({ strict: false });
        const config = {
          env: {
            VAR_A: "${VAR_B}",
            VAR_B: "${VAR_A}"
          }
        };

        const result = await nonStrictResolver.resolveConfig(config, ['env']);

        // Should fallback to original values when circular dependency detected
        expect(result.env.VAR_A).toBe('${VAR_B}');
        expect(result.env.VAR_B).toBe('${VAR_A}');
      });

      describe("Error Handling", () => {
        describe("Strict Mode (Default)", () => {
          it("should throw error on command execution failures", async () => {
            mockExecPromise.mockRejectedValueOnce(new Error("Command failed"));

            const config = {
              headers: {
                "Authorization": "Bearer ${cmd: failing-command}"
              }
            };

            await expect(resolver.resolveConfig(config, ['headers']))
              .rejects.toThrow("cmd execution failed: Command failed");
          });

          it("should throw error on unresolved environment variables", async () => {
            const config = {
              env: {
                SIMPLE_VAR: "${UNKNOWN_VAR}"
              }
            };

            await expect(resolver.resolveConfig(config, ['env']))
              .rejects.toThrow("Variable 'UNKNOWN_VAR' not found");
          });

          it("should throw error on legacy syntax with missing variables", async () => {
            const config = {
              args: ["--token", "$UNKNOWN_LEGACY_VAR"]
            };

            await expect(resolver.resolveConfig(config, ['args']))
              .rejects.toThrow("Legacy variable 'UNKNOWN_LEGACY_VAR' not found");
          });

          it("should detect circular dependencies eventually", async () => {
            // Create a scenario where circular deps are detected before individual var failures
            // Use a non-strict resolver to test the circular dependency detection logic
            const nonStrictResolver = new EnvResolver({ strict: false });
            const config = {
              env: {
                VAR_A: "${VAR_B}",
                VAR_B: "${VAR_C}",
                VAR_C: "${VAR_A}"
              }
            };

            const result = await nonStrictResolver.resolveConfig(config, ['env']);

            // In non-strict mode, circular dependencies should be detected and values left as-is
            expect(result.env.VAR_A).toBe('${VAR_B}');
            expect(result.env.VAR_B).toBe('${VAR_C}');
            expect(result.env.VAR_C).toBe('${VAR_A}');
          });

          it("should throw error on mixed placeholders with failures", async () => {
            const config = {
              url: "https://${KNOWN_VAR}.${UNKNOWN_VAR}.com"
            };

            const context = { KNOWN_VAR: 'api' };
            process.env.KNOWN_VAR = 'api';

            await expect(resolver.resolveConfig(config, ['url']))
              .rejects.toThrow("Variable 'UNKNOWN_VAR' not found");
          });
        });
      })

      describe("Non-Strict Mode", () => {
        beforeEach(() => {
          resolver = new EnvResolver({ strict: false });
        });

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

        it("should handle unresolved variables gracefully", async () => {
          const config = {
            env: {
              SIMPLE_VAR: "${UNKNOWN_VAR}",
              KNOWN_VAR: "${TEST_VAR}"
            }
          };

          const result = await resolver.resolveConfig(config, ['env']);

          expect(result.env.SIMPLE_VAR).toBe('${UNKNOWN_VAR}'); // Keep original
          expect(result.env.KNOWN_VAR).toBe('test_value'); // Resolved
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

      describe("General Error Handling", () => {
        it("should handle non-string values gracefully", async () => {
          // Use non-strict resolver for this test
          const nonStrictResolver = new EnvResolver({ strict: false });

          const config = {
            env: {
              NUMBER: 123,
              BOOLEAN: true,
              NULL_VAL: null
            },
            args: ["string", 456, true]
          };

          const result = await nonStrictResolver.resolveConfig(config, ['env', 'args']);

          expect(result.env.NUMBER).toBe(123);
          expect(result.env.BOOLEAN).toBe(true);
          expect(result.env.NULL_VAL).toBe(''); // null with no fallback in non-strict mode
          expect(result.args).toEqual(["string", 456, true]);
        });

        it("should provide clear error messages with context", async () => {
          const config = {
            headers: {
              "Authorization": "Bearer ${MISSING_TOKEN}"
            }
          };

          await expect(resolver.resolveConfig(config, ['headers']))
            .rejects.toThrow(/Variable.*MISSING_TOKEN.*not found/);
        });
      });
    });
  });
});
