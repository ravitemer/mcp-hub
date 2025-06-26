# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.7.0] - 2025-06-26

### Added

- **XDG Base Directory Specification Support**: Migrated from hardcoded ~/.mcp-hub paths to XDG-compliant directories
  - Marketplace cache now uses XDG data directory (`~/.local/share/mcp-hub/cache`)
  - Logs now use XDG state directory (`~/.local/state/mcp-hub/logs`)
  - OAuth storage now uses XDG data directory (`~/.local/share/mcp-hub/oauth-storage.json`)
  - Backward compatibility maintained for existing ~/.mcp-hub installations
  - New XDG paths utility module with automatic fallback logic

### Enhanced

- Updated documentation to reflect new XDG-compliant path structure
- Improved file organization following Linux filesystem standards

## [3.6.0] - 2025-06-24

### Added

- **Unified MCP Server Endpoint**: New /mcp endpoint that exposes all capabilities from managed servers
  - Single endpoint for all MCP clients (Claude Desktop, Cline, etc.) to connect to
  - Automatic namespacing of capabilities to prevent conflicts between servers
  - Real-time capability synchronization when servers are added/removed/restarted
  - Support for tools, resources, resource templates, and prompts from all servers

### Enhanced

- Added comprehensive health monitoring with MCP endpoint statistics
- Improved capability change detection with efficient key-based comparison
- Added detailed documentation explaining the unified server approach

### Changed

- Refactored capability synchronization for better performance
- Simplified capability change detection by removing complex deep comparisons

## [3.5.0] - 2025-06-24

### Added

- Manual OAuth callback endpoint for improved headless server support
- Support for manual authorization flow in remote/headless environments

## [3.4.5] - 2025-06-18

### Fixed

- Fixed nested placeholder resolution in environment variables not working correctly

## [3.4.4] - 2025-06-16

### Fixed

- Fixed validation issue with some resource templates not recognized properly.

## [3.4.3] - 2025-06-12

### Changed

- Revert `yargs` to v17 to maintain compatibility with Node.js v18

## [3.4.2] - 2025-06-11

### Changed

- Environment variable resolution now uses strict mode by default - configuration errors prevent server startup

## [3.4.1] - 2025-06-11

### Fixed

- Fixed `${cmd: ...}` placeholders not working in remote server configs without an `env` field
- Commands can now be executed in any config field (url, headers, args, command), not just env
- Better handling of circular dependencies in environment variable resolution

## [3.4.0] - 2025-06-10

### Added

- **Universal `${}` Placeholder Syntax**: Centralized environment variable resolution system
  - `${ENV_VAR}` for environment variables
  - `${cmd: command args}` for command execution
  - Support across all configuration fields: `command`, `args`, `env`, `url`, `headers`

### Deprecated

- Legacy `$VAR` syntax in args (use `${VAR}` instead)
- Legacy `$: command` syntax in env (use `${cmd: command}` instead)
- All deprecated syntax now shows deprecation warnings

### Enhanced

- Updated documentation with clear examples of new universal syntax
- Improved configuration section clarity and examples

## [3.3.5] - 2025-06-05

### Fixed

- Fetching marketplace data fails with proxy or vpn using node fetch. Uses curl as fallback
- Don't throw error if reamdeContent is empty

## [3.3.4] - 2025-06-05

### Added

- MCP server configs can have a `name` field. Ideally it should be used as a displayName when present.

## [3.3.3] - 2025-06-04

### Changed

- Update dependencies to latest versions

## [3.3.2] - 2025-06-04

### Changed

- Locally update the hash of flake.nix and release version with all changes at a time.
- Remove flake github workflow

## [3.3.1] - 2025-05-30

### Fixed

- Use correct constant name `TOOL_LIST_CHANGED` instead of `TOOLS_CHANGED` for tool list subscription events

## [3.3.0] - 2025-05-26

### Added

- Dev mode for automatic MCP server restart on file changes during development
- New `dev` configuration field with `enabled`, `watch`, and `cwd` options
- File watching with glob pattern support for universal project compatibility

## [3.2.0] - 2025-05-24

### Added

- /tools, /resources, /prompts endpoints accept request_options in the body which will be used when calling tools, resources and prompts.

## [3.1.11] - 2025-05-16

### Fixed

- Warn instead of throwing error for MCP Server stderr output

## [3.1.10] - 2025-05-06

### Fixed

- Remove log statement

## [3.1.9] - 2025-05-06

### Added

- Support for `$: cmd arg1 arg2` syntax in env config to execute shell commands to resolve env values
- E.g

```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-everything"],
  "env": {
    "MY_ENV_VAR": "$: cmd:op read op://mysecret/myenvvar"
  }
}
```

## [3.1.8] - 2025-05-03

### Changed

- Update open and @modelcontextprotocol/sdk to latest versions

## [3.1.7] - 2025-04-30

### Fixed

- Refetch marketplace catalog if empty

## [3.1.6] - 2025-04-25

### Added

- /hard-restart endpoint

### Changed

- Reverted express v5 to v4

## [3.1.5] - 2025-04-25

### Fixed

- Subscribed to notifications from a server even after it was stopped

### Changed

- Updated dependencies to their latest versions

## [3.1.4] - 2025-04-24

### Added

- Can use "Bearer ${SOME_OTHER_ENV}" in headers field of remote MCP server config

## [3.1.3] - 2025-04-24

### Added

- Can use "ENV_VAR": "${SOME_OTHER_ENV}" in env field in server config

## [3.1.2] - 2025-04-23

### Fixed

- start and stop behavior for servers broken

## [3.1.1] - 2025-04-23

### Fixed

- False positive modified triggers when env field is falsy due to lack of deep cloning

## [3.1.0] - 2025-04-23

### Added

- Support for MCP 2025-03-26 specification
- Primary streamable-http transport for remote servers
- SSE fallback transport support
- OAuth 2.0 authentication with PKCE flow
- Comprehensive feature support matrix in documentation

## [3.0.5] - 2025-04-21

### Added

- replaces args that start with `$` like `$ENV_VAR` with actual env var value.
- Need to mention ENV_VAR in the "env" field in server config to avoid any side-effects

## [3.0.4] - 2025-04-20

### Fixed

- handle config changes in parallel in case one fails others should not fail
- Starting a connection not updating it's config properly

## [3.0.3] - 2025-04-14

### Fixed

- send SERVERS_UPDATED event for servers start and stop endpoints

## [3.0.2] - 2025-04-13

### Fixed

- insignificant changes emiting importantChangesHandled event

## [3.0.1] - 2025-04-13

### Fixed

- Improved file watching reliability across different editors
- Fixed issue with Neovim file watching not triggering after first change
- Enhanced cleanup of file watchers during shutdown
- Added proper resource cleanup for file watchers

## [3.0.0] - 2025-04-13

### Breaking Changes

- Removed client registration/unregistration API endpoints
- All clients now connect directly via SSE at /api/events
- Simplified client connection management to SSE-only model

### Added

- Enhanced SSE client connection tracking
- Improved client event notifications
- More detailed connection metrics in health endpoint
- Better documentation with updated architecture diagrams

### Enhanced

- Improved --watch to only update affected servers on config changes
- Smarter config watching with better change detection

### Changed

- Logging system now writes to ~/.mcp-hub/logs/mcp-hub.log

## [2.2.0] - 2025-04-10

### Added

- mcp-hub stays up running even when all clients disconnect unless `--auto-shutdown` is provided
- Helpful for running mcp-hub as systemd or separate process to avoid
  frequent startups

## [2.1.1] - 2025-04-07

### Fixed

- Fixed server_name not defined errors in route handlers

## [2.1.0] - 2025-04-05

### Added

- Added SSE (Server-Sent Events) transport support for remote MCP servers
- Automatic server type detection (STDIO/SSE) based on configuration
- SSE-specific error handling and connection management
- Documentation for SSE server configuration and examples

## [2.0.1] - 2025-04-04

### Fixed

- Fixed package dependencies in package-lock.json
- Updated flake.nix with correct npmDepsHash

## [2.0.0] - 2025-04-04

### Breaking Changes

- Changed all server operations endpoints to use server_name in request body instead of URL parameters:
  - `POST /servers/:name/start` -> `POST /servers/start` with server_name in body
  - `POST /servers/:name/stop` -> `POST /servers/stop` with server_name in body
  - `GET /servers/:name/info` -> `POST /servers/info` with server_name in body
  - `POST /servers/:name/refresh` -> `POST /servers/refresh` with server_name in body
  - `POST /servers/:name/tools` -> `POST /servers/tools` with server_name in body
  - `POST /servers/:name/resources` -> `POST /servers/resources` with server_name in body

### Added

- New prompts capability allowing MCP servers to provide and execute prompts
- New POST /servers/prompts endpoint for accessing server prompts
- Real-time prompt list change notifications via SSE events
- Updated documentation with prompt-related features and endpoint changes

## [1.8.1] - 2025-04-02

### Added

- New POST /restart endpoint to reload config and restart MCP Hub servers
- Improved server shutdown logging with clearer status messages
- Extended marketplace cache TTL to 24 hours

## [1.8.0] - 2025-03-31

### Changed

- Moved runtime dependencies to devDependencies and bundled them for better compatibility
- Added prepublishOnly script to ensure dist/cli.js is built before publishing
- Improved build process to include all dependencies in the bundle

## [1.7.3] - 2025-03-22

### Fixed

- Version reporting now works correctly across all Node.js environments by using build step
- Improved project structure by moving to built dist/cli.js
- Enhanced documentation with embedded mermaid diagrams

## [1.7.2] - 2025-03-20

### Fixed

- improper version in package-lock.json

## [1.7.1] - 2025-03-15

### Enhanced

- Improved marketplace integration with user-friendly display names
- Enhanced marketplace cache initialization and error recovery
- Optimized startup by loading marketplace before MCP Hub

## [1.7.0] - 2025-03-14

### Added

- Integrated marketplace functionality for discovering and managing MCP servers
- New API endpoints for marketplace interactions:
  - GET /marketplace - List available servers with filtering and sorting
  - POST /marketplace/details - Get detailed server information
- Enhanced marketplace caching system for better performance
- Comprehensive test suite for marketplace functionality

## [1.6.2] - 2025-03-12

### Changed

- Enhanced environment variable handling:
  - Added getDefaultEnvironment from SDK for proper MCP server initialization
  - Added support for MCP_ENV_VARS environment variable to pass additional variables
  - Improved default environment configuration

## [1.6.1] - 2025-03-12

### Fixed

- Allow fallback to process.env for falsy environment variables in config.env (#3)

## [1.6.0] - 2025-03-11

### Added

- Real-time tool and resource capability notifications from MCP servers
- New endpoints for refreshing server capabilities:
  - POST /servers/:name/refresh - Refresh specific server
  - POST /refresh - Refresh all servers
- Enhanced event system for tool and resource list changes
- Automatic capability updates when tools or resources change
- Structured logging for capability changes

### Enhanced

- MCPConnection and MCPHub now extend EventEmitter for better event handling
- Improved notification handling with proper SDK schemas
- Better error handling for capability updates
- Parallel execution of server capability refreshes

## [1.5.0] - 2025-03-06

### Changed

- Improved error handling and logging in MCPConnection and MCPHub
- Simplified server connection management
- Enhanced error message clarity for server connections
- Standardized server error codes

## [1.4.1] - 2025-03-06

### Fixed

- `--version` flag returning unknown on bun ([#1](https://github.com/ravitemer/mcp-hub/issues/1))

## [1.4.0] - 2025-03-05

### Added

- New server control endpoints for start/stop operations with state management
- Parallel execution for server startup and shutdown operations
- Enhanced server state management with disable capability
- Improved logging for server lifecycle operations
- Better error handling and status reporting for server operations

## [1.3.0] - 2025-03-02

### Added

- New `shutdown-delay` CLI option to control delay before server shutdown when no clients are connected
- Enhanced logging messages with improved clarity and context across all components
- More descriptive server status messages and operation feedback
- Integration example with ravitemer/mcphub.nvim Neovim plugin

### Changed

- Simplified signal handler setup for more reliable graceful shutdown
- Improved logging message clarity and contextual information
- Reorganized server shutdown logic for better reliability

## [1.2.0] - 2025-02-22

### Added

- Enhanced MCPConnection with detailed response examples for various scenarios (text, image, resources)
- Added argument validation for tool calls to ensure correct parameter types
- Improved error handling in HTTP router with Promise error handling wrapper

## [1.1.0] - 2025-02-21

### Added

- Comprehensive error handling system with custom error classes (ConfigError, ConnectionError, ServerError, ToolError, ResourceError, ValidationError)
- Structured JSON logging with standardized error codes and detailed error information
- Enhanced CLI error management with improved error recovery
- Error code based error handling for better error identification and debugging

### Changed

- Simplified logging system with JSON-only output
- More consistent error handling patterns across all components
- Improved error recovery and reporting mechanisms

## [1.0.0] - 2024-02-20

### Added

- Initial release of MCP Hub
- Dynamic MCP server management and monitoring
- REST API for tool execution and resource access
- Real-time server status tracking via SSE
- Client connection management
- Process lifecycle handling
- Configuration-based server initialization
- Health monitoring and status tracking
- Automatic reconnection attempts
- Comprehensive error handling
- JSON-based logging
- API documentation
- Example implementations
- Test suite with high coverage



