# MCP Hub 

[![npm version](https://badge.fury.io/js/mcp-hub.svg)](https://www.npmjs.com/package/mcp-hub)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

MCP Hub acts as a central coordinator between clients and multiple MCP servers, making it easy to utilize capabilities from multiple servers through a single interface. Implements [MCP 2025-03-26](https://modelcontextprotocol.io/specification/2025-03-26) specification.

## Feature Support

| Category | Feature | Support | Notes |
|----------|---------|---------|-------|
| **Transport** ||||
| | streamable-http | ✅ | Primary transport protocol for remote servers |
| | SSE | ✅ | Fallback transport for remote servers |
| | STDIO | ✅ | For running local servers |
| **Authentication** ||||
| | OAuth 2.0 | ✅ | With PKCE flow |
| | Headers | ✅ | For API keys/tokens |
| **Capabilities** ||||
| | Tools | ✅ | List tools |
| | 🔔 Tool List Changed | ✅ | Real-time updates |
| | Resources | ✅ | Full support |
| | 🔔 Resource List Changed | ✅ | Real-time updates |
| | Resource Templates | ✅ | URI templates |
| | Prompts | ✅ | Full support |
| | 🔔 Prompts List Changed | ✅ | Real-time updates |
| | Roots | ❌ | Not supported |
| | Sampling | ❌ | Not supported |
| | Completion | ❌ | Not supported |
| **Marketplace** ||||
| | Server Discovery | ✅ | Browse available servers |
| | Installation | ✅ | Auto configuration |
| **Real-time** ||||
| | Status Updates | ✅ | Server & connection state |
| | Capability Updates | ✅ | Automatic refresh |
| | Event Streaming to clients | ✅ | SSE-based |
| | Auto Reconnection | ✅ | With backoff |

## Key Features

- **Dynamic Server Management**:
  - Start, stop, enable/disable servers on demand
  - Real-time configuration updates with automatic server reconnection
  - Support for local (STDIO) and remote (streamable-http/SSE) MCP servers 
  - Health monitoring and automatic recovery
  - OAuth authentication with PKCE flow
  - Header-based token authentication

- **Unified REST API**:
  - Execute tools from any connected server
  - Access resources and resource templates
  - Real-time status updates via Server-Sent Events (SSE)
  - Full CRUD operations for server management

- **Real-time Events & Monitoring**:
  - Live server status and capability updates
  - Client connection tracking
  - Tool and resource list change notifications
  - Structured JSON logging with file output

- **Client Connection Management**:
  - Simple SSE-based client connections via /api/events
  - Automatic connection cleanup on disconnect
  - Optional auto-shutdown when no clients connected
  - Real-time connection state monitoring

- **Process Lifecycle Management**:
  - Graceful startup and shutdown handling
  - Proper cleanup of server connections
  - Error recovery and reconnection

### Components

#### Hub Server
The main management server that:
- Maintains connections to multiple MCP servers
- Provides unified API access to server capabilities
- Handles server lifecycle and health monitoring
- Manages SSE client connections and events
- Processes configuration updates and server reconnection

#### MCP Servers
Connected services that:
- Provide tools, resources, templates, and prompts
- Support two connectivity modes:
  - Script-based STDIO servers for local operations
  - Remote servers (streamable-http/SSE) with OAuth support
- Implement real-time capability updates
- Support automatic status recovery
- Maintain consistent interface across transport types

## Installation

```bash
npm install -g mcp-hub
```

## Basic Usage

Start the hub server:

```bash
mcp-hub --port 3000 --config path/to/config.json
```

### CLI Options
```bash
Options:
  --port            Port to run the server on (required)
  --config          Path to config file (required)
  --watch           Watch config file for changes, only updates affected servers (default: false)
  --auto-shutdown   Whether to automatically shutdown when no clients are connected (default: false)
  --shutdown-delay  Delay in milliseconds before shutting down when auto-shutdown is enabled (default: 0)
  -h, --help       Show help information
```

## Configuration

MCP Hub uses a JSON configuration file to define managed servers:

```js
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["arg1", "$ACCESS_TOKEN"], //$ACCESS_TOKEN is replaced with ACCESS_TOKEN from env field
      "env": {
        "ACCESS_TOKEN": null, // Fallback to process.env.ACCESS_TOKEN for null or ""
        "OP_KEY": "$: cmd:op read read op://example/secret", // use $: at the beginning to indicate that this is a command
        "AUTH_HEADER": "Bearer ${ACCESS_TOKEN}", // Placeholders will be replaced with values from the env object itself and falling back to process.env
        "SECRET": "secret" // Uses "secret"

      },
    },
    "remote-server": {
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${EXAMPLE_API_KEY}" // Replaced with env value
      },
    }
  }
}
```

### Configuration Options

MCP Hub supports both STDIO servers and remote servers (streamable-http/SSE). The server type is automatically detected from the configuration.

#### STDIO Server Options

For running script-based MCP servers locally:

- **command**: Command to start the MCP server executable
- **args**: Array of command line arguments (arguments starting with `$` will be replaced with env values if available)
- **env**: Environment variables with system fallback if value is empty/null

#### Remote Server Options

For connecting to remote MCP servers:

- **url**: Server endpoint URL
- **headers**: Optional headers for authentication

The server type is determined by:
- STDIO server → Has `command` field
- Remote server → Has `url` field

Note: A server configuration cannot mix STDIO and remote server fields.

## Nix

### Nixpkgs install

> coming...

### Flake install

Just add it to your NixOS flake.nix or home-manager:

```nix
inputs = {
  mcp-hub.url = "github:ravitemer/mcp-hub";
  ...
}
```

To integrate mcp-hub to your NixOS/Home Manager configuration, add the following to your environment.systemPackages or home.packages respectively:

```nix
inputs.mcp-hub.packages."${system}".default
```

### Usage without install

If you want to use mcphub.nvim without having mcp-hub server in your PATH you can link the server under the hood adding
the mcp-hub nix store path to the `cmd` command in the plugin config like

[Nixvim](https://github.com/nix-community/nixvim) example:
```nix
{ mcphub-nvim, mcp-hub, ... }:
{
  extraPlugins = [mcphub-nvim];
  extraConfigLua = ''
    require("mcphub").setup({
        port = 3000,
        config = vim.fn.expand("~/mcp-hub/mcp-servers.json"),
        cmd = "${mcp-hub}/bin/mcp-hub"
    })
  '';
}

# where
{
  # For nixpkgs (not available yet)
  mcp-hub = pkgs.mcp-hub;

  # For flakes
  mcp-hub = inputs.mcp-hub.packages."${system}".default;
}
```

## Example Integrations

### Neovim Integration

The [ravitemer/mcphub.nvim](https://github.com/ravitemer/mcphub.nvim) plugin provides seamless integration with Neovim, allowing direct interaction with MCP Hub from your editor:

- Execute MCP tools directly from Neovim
- Access MCP resources within your editing workflow
- Real-time status updates in Neovim
- Auto install mcp servers with marketplace addition

## REST API

### Health and Status

#### Health Check

```bash
GET /api/health
```

The health endpoint provides comprehensive status information including:
- Current hub state (starting, ready, restarting, restarted, stopping, stopped, error)
- Connected server statuses and capabilities
- Active SSE connection details
- Detailed connection metrics
- Error state details if applicable

Response:
```json
{
  "status": "ok",
  "state": "ready",
  "server_id": "mcp-hub",
  "activeClients": 2,
  "timestamp": "2024-02-20T05:55:00.000Z",
  "servers": [],
  "connections": {
    "totalConnections": 2,
    "connections": [
      {
        "id": "client-uuid",
        "state": "connected",
        "connectedAt": "2024-02-20T05:50:00.000Z",
        "lastEventAt": "2024-02-20T05:55:00.000Z"
      }
    ]
  }
}
```

#### List MCP Servers

```bash
GET /api/servers
```

#### Get Server Info

```bash
POST /api/servers/info
Content-Type: application/json

{
  "server_name": "example-server"
}
```

#### Refresh Server Capabilities

```bash
POST /api/servers/refresh
Content-Type: application/json

{
  "server_name": "example-server"
}
```

Response:

```json
{
  "status": "ok",
  "server": {
    "name": "example-server",
    "capabilities": {
      "tools": ["tool1", "tool2"],
      "resources": ["resource1", "resource2"],
      "resourceTemplates": []
    }
  },
  "timestamp": "2024-02-20T05:55:00.000Z"
}
```

#### Refresh All Servers

```bash
POST /api/refresh
```

Response:

```json
{
  "status": "ok",
  "servers": [
    {
      "name": "example-server",
      "capabilities": {
        "tools": ["tool1", "tool2"],
        "resources": ["resource1", "resource2"],
        "resourceTemplates": []
      }
    }
  ],
  "timestamp": "2024-02-20T05:55:00.000Z"
}
```

#### Start Server

```bash
POST /api/servers/start
Content-Type: application/json

{
  "server_name": "example-server"
}
```

Response:

```json
{
  "status": "ok",
  "server": {
    "name": "example-server",
    "status": "connected",
    "uptime": 123
  },
  "timestamp": "2024-02-20T05:55:00.000Z"
}
```

#### Stop Server

```bash
POST /api/servers/stop?disable=true|false
Content-Type: application/json

{
  "server_name": "example-server"
}
```

The optional `disable` query parameter can be set to `true` to disable the server in the configuration.

Response:

```json
{
  "status": "ok",
  "server": {
    "name": "example-server",
    "status": "disconnected",
    "uptime": 0
  },
  "timestamp": "2024-02-20T05:55:00.000Z"
}
```

### Marketplace Integration

#### List Available Servers

```bash
GET /api/marketplace
```

Query Parameters:

- `search`: Filter by name, description, or tags
- `category`: Filter by category
- `tags`: Filter by comma-separated tags
- `sort`: Sort by "newest", "stars", or "name"

Response:

```json
{
  "items": [
    {
      "mcpId": "github.com/user/repo/server",
      "name": "Example Server",
      "description": "Description here",
      "category": "search",
      "tags": ["search", "ai"],
      "githubStars": 100,
      "isRecommended": true,
      "createdAt": "2024-02-20T05:55:00.000Z"
    }
  ],
  "timestamp": "2024-02-20T05:55:00.000Z"
}
```

#### Get Server Details

```bash
POST /api/marketplace/details
Content-Type: application/json

{
  "mcpId": "github.com/user/repo/server"
}
```

Response:

```json
{
  "server": {
    "mcpId": "github.com/user/repo/server",
    "name": "Example Server",
    "description": "Description here",
    "githubUrl": "https://github.com/user/repo",
    "readmeContent": "# Server Documentation...",
    "llmsInstallationContent": "Installation guide..."
  },
  "timestamp": "2024-02-20T05:55:00.000Z"
}
```

### MCP Server Operations

#### Execute Tool

```bash
POST /api/servers/tools
Content-Type: application/json

{
  "server_name": "example-server",
  "tool": "tool_name",
  "arguments": {}
}
```

#### Access Resource

```bash
POST /api/servers/resources
Content-Type: application/json

{
  "server_name": "example-server",
  "uri": "resource://uri"
}
```

#### Get Prompt

```bash
POST /api/servers/prompts
Content-Type: application/json

{
  "server_name": "example-server",
  "prompt": "prompt_name",
  "arguments": {}
}
```

Response:

```json
{
  "result": {
    "messages": [
      {
        "role": "assistant",
        "content": {
          "type": "text",
          "text": "Text response example"
        }
      },
      {
        "role": "assistant",
        "content": {
          "type": "image",
          "data": "base64_encoded_image_data",
          "mimeType": "image/png"
        }
      }
    ]
  },
  "timestamp": "2024-02-20T05:55:00.000Z"
}
```

#### Restart Hub

```bash
POST /api/restart
```

Reloads the configuration file and restarts all MCP servers.

Response:

```json
{
  "status": "ok",
  "timestamp": "2024-02-20T05:55:00.000Z"
}
```

## Real-time Events System

MCP Hub implements a comprehensive real-time events system using Server-Sent Events (SSE) at `/api/events`. This endpoint provides live updates about server status, configuration changes, capability updates, and more.

### Hub States

The hub server transitions through several states during its lifecycle:

| State | Description |
|-------|-------------|
| `starting` | Initial startup, loading configuration |
| `ready` | Server is running and ready to handle requests |
| `restarting` | Reloading configuration/reconnecting servers |
| `restarted` | Configuration reload complete |
| `stopping` | Graceful shutdown in progress |
| `stopped` | Server has fully stopped |
| `error` | Error state (includes error details) |

You can monitor these states through the `/health` endpoint or SSE events.

### Event Types

MCP Hub emits several types of events:

#### Core Events

1. **heartbeat** - Periodic connection health check
```json
{
  "connections": 2,
  "timestamp": "2024-02-20T05:55:00.000Z"
}
```

2. **hub_state** - Hub server state changes
```json
{
  "state": "ready",
  "server_id": "mcp-hub",
  "version": "1.0.0",
  "pid": 12345,
  "port": 3000,
  "timestamp": "2024-02-20T05:55:00.000Z"
}
```

3. **log** - Server log messages
```json
{
  "type": "info",
  "message": "Server started",
  "data": {},
  "timestamp": "2024-02-20T05:55:00.000Z"
}
```

#### Subscription Events

1. **config_changed** - Configuration file changes detected
```json
{
  "type": "config_changed",
  "newConfig": {},
  "isSignificant": true,
  "timestamp": "2024-02-20T05:55:00.000Z"
}
```

2. **servers_updating** - Server updates in progress
```json
{
  "type": "servers_updating",
  "changes": {
    "added": ["server1"],
    "removed": [],
    "modified": ["server2"],
    "unchanged": ["server3"]
  },
  "timestamp": "2024-02-20T05:55:00.000Z"
}
```

3. **servers_updated** - Server updates completed
```json
{
  "type": "servers_updated",
  "changes": {
    "added": ["server1"],
    "removed": [],
    "modified": ["server2"],
    "unchanged": ["server3"]
  },
  "timestamp": "2024-02-20T05:55:00.000Z"
}
```

4. **tool_list_changed** - Server's tools list updated
```json
{
  "type": "tool_list_changed",
  "server": "example-server",
  "tools": ["tool1", "tool2"],
  "timestamp": "2024-02-20T05:55:00.000Z"
}
```

5. **resource_list_changed** - Server's resources/templates updated
```json
{
  "type": "resource_list_changed",
  "server": "example-server",
  "resources": ["resource1", "resource2"],
  "resourceTemplates": [],
  "timestamp": "2024-02-20T05:55:00.000Z"
}
```

6. **prompt_list_changed** - Server's prompts list updated
```json
{
  "type": "prompt_list_changed",
  "server": "example-server",
  "prompts": ["prompt1", "prompt2"],
  "timestamp": "2024-02-20T05:55:00.000Z"
}
```
### Connection Management

- Each SSE connection is assigned a unique ID
- Connections are automatically cleaned up on client disconnect
- Connection statistics available via `/health` endpoint
- Optional auto-shutdown when no clients are connected

## Logging

MCP Hub uses structured JSON logging for all events. Logs are written to both console and file at `~/.mcp-hub/logs/mcp-hub.log`:

```json
{
  "type": "error",
    "code": "TOOL_ERROR",
    "message": "Failed to execute tool",
    "data": {
      "server": "example-server",
      "tool": "example-tool",
      "error": "Invalid parameters"
    },
    "timestamp": "2024-02-20T05:55:00.000Z"
}
```

Log levels include:

- `info`: Normal operational messages
- `warn`: Warning conditions
- `debug`: Detailed debug information (includes configuration changes)
- `error`: Error conditions (includes error code and stack trace)

Logs are rotated daily and kept for 30 days by default.


## Error Handling

MCP Hub implements a comprehensive error handling system with custom error classes for different types of errors:

### Error Classes

- **ConfigError**: Configuration-related errors (invalid config, missing fields)
- **ConnectionError**: Server connection issues (failed connections, transport errors)
- **ServerError**: Server startup/initialization problems
- **ToolError**: Tool execution failures
- **ResourceError**: Resource access issues
- **ValidationError**: Request validation errors

Each error includes:

- Error code for easy identification
- Detailed error message
- Additional context in the details object
- Stack trace for debugging

Example error structure:

```json
{
  "code": "CONNECTION_ERROR",
  "message": "Failed to communicate with server",
  "details": {
    "server": "example-server",
    "error": "connection timeout"
  },
  "timestamp": "2024-02-20T05:55:00.000Z"
}
```

## Architecture

### Hub Server Lifecycle

```mermaid
sequenceDiagram
    participant C as Client
    participant H as Hub Server
    participant M1 as MCP Server 1
    participant M2 as MCP Server 2

    Note over H: Server Start (state: starting)
    activate H
    
    Note over H: Config Loading
    H->>H: Load & Validate Config
    H->>H: Watch Config File
    H->>H: Initialize SSE Manager
    
    Note over H: Server Connections (state: ready)
    H->>+M1: Connect
    M1-->>-H: Connected + Capabilities
    H->>+M2: Connect
    M2-->>-H: Connected + Capabilities
    H-->>C: hub_state (ready)

    Note over C,H: Client Setup
    C->>H: Connect to /api/events (SSE)
    H-->>C: connection_opened
    
    Note over C,H: Client Operations
    C->>H: Execute Tool (HTTP)
    H->>M1: Execute Tool
    M1-->>H: Tool Result
    H-->>C: HTTP Response
    
    Note over H,C: Real-time Updates
    H->>H: Detect Config Change
    H-->>C: servers_updating (SSE)
    H->>M1: Reconnect with New Config
    M1-->>H: Updated Capabilities
    H-->>C: servers_updated (SSE)

    Note over H,C: Server Events
    M2->>H: Tool List Changed
    H-->>C: tool_list_changed (SSE)
    
    Note over H: Shutdown Process
    Note over C,H: Client Disconnects
    H-->>C: hub_state (stopping) (SSE)
    H->>M1: Disconnect
    H->>M2: Disconnect
    H-->>C: hub_state (stopped) (SSE)
    deactivate H
```

The Hub Server coordinates communication between clients and MCP servers:

1. Starts and connects to configured MCP servers
2. Handles SSE client connections and events
3. Routes tool and resource requests to appropriate servers
4. Monitors server health and maintains capabilities
5. Manages graceful startup/shutdown processes

### MCP Server Management

```mermaid
flowchart TB
    A[Hub Server Start] --> B{Config Available?}
    B -->|Yes| C[Load Server Configs]
    B -->|No| D[Use Default Settings]
    
    C --> E[Initialize Connections]
    D --> E
    
    E --> F{For Each MCP Server}
    F -->|Enabled| G[Attempt Connection]
    F -->|Disabled| H[Skip Server]
    
    G --> I{Connection Status}
    I -->|Success| J[Fetch Capabilities]
    I -->|Failure| K[Log Error]
    
    J --> L[Store Server Info]
    K --> M[Mark Server Unavailable]
    
    L --> N[Monitor Health]
    M --> N
    
    N --> O{Health Check}
    O -->|Healthy| P[Update Capabilities]
    O -->|Unhealthy| Q[Attempt Reconnect]
    
    Q -->|Success| P
    Q -->|Failure| R[Update Status]
    
    P --> N
    R --> N
```

The Hub Server actively manages MCP servers through:

1. Configuration-based server initialization
2. Connection and capability discovery
3. Health monitoring and status tracking
4. Automatic reconnection attempts
5. Server state management

### Request Handling

```mermaid
sequenceDiagram
    participant C as Client
    participant H as Hub Server
    participant M as MCP Server
    
    Note over C,H: Tool Execution
    C->>H: POST /api/servers/tools (HTTP)
    H->>H: Validate Request & Server
    
    alt Server Not Connected
        H-->>C: 503 Server Unavailable (HTTP)
    else Server Connected
        H->>M: Execute Tool
        
        alt Success
            M-->>H: Tool Result
            H-->>C: Result Response (HTTP)
        else Error
            M-->>H: Error Details
            H-->>C: Error Response (HTTP)
            H-->>C: log (SSE Event)
        end
    end
    
    Note over C,H: Resource Access
    C->>H: POST /api/servers/resources (HTTP)
    H->>H: Validate URI & Template
    
    alt Invalid Resource
        H-->>C: 404 Not Found (HTTP)
    else Server Not Connected
        H-->>C: 503 Unavailable (HTTP)
    else Valid Request
        H->>M: Request Resource
        
        alt Success
            M-->>H: Resource Data
            H-->>C: Resource Content (HTTP)
        else Error
            M-->>H: Error Details
            H-->>C: Error Response (HTTP)
            H-->>C: log (SSE Event)
        end
    end
    
    Note over C,H: Prompt Execution
    C->>H: POST /api/servers/prompts (HTTP)
    H->>H: Validate Prompt & Args
    
    alt Invalid Prompt
        H-->>C: 404 Not Found (HTTP)
    else Server Not Connected
        H-->>C: 503 Unavailable (HTTP)
    else Valid Request
        H->>M: Execute Prompt
        
        alt Success
            M-->>H: Messages Array
            H-->>C: Messages Response (HTTP)
        else Error
            M-->>H: Error Details
            H-->>C: Error Response (HTTP)
            H-->>C: log (SSE Event)
        end
    end
```

All client requests follow a standardized flow:

1. Request validation
2. Server status verification
3. Request routing to appropriate MCP server
4. Response handling and error management

## Requirements

- Node.js >= 18.0.0

## Todo

- [ ] Implement custom marketplace rather than depending on mcp-marketplace

## Acknowledgements

- [Cline mcp-marketplace](https://github.com/cline/mcp-marketplace) - For providing the MCP server marketplace endpoints that power MCP Hub's marketplace integration
