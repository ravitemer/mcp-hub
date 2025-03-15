# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
