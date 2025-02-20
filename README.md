# MCP Hub

A centralized manager for Model Context Protocol (MCP) servers that provides:

- Dynamic MCP server management and monitoring
- REST API for tool execution and resource access
- Real-time server status tracking
- Client connection management
- Process lifecycle handling

## Overview

### Hub Server vs MCP Servers

- **Hub Server (MCP Hub)**

  - Central management server that connects to and manages multiple MCP servers
  - Provides unified API endpoints for clients to access MCP server capabilities
  - Handles server lifecycle, health monitoring, and client connections
  - Routes requests between clients and appropriate MCP servers

- **MCP Servers**
  - Individual servers that provide specific tools and resources
  - Each server has its own capabilities (tools, resources, templates)
  - Connected to and managed by the Hub server
  - Process requests from clients through the Hub

## Installation

```bash
npm install -g mcp-hub
```

## Basic Usage

Start the hub server:

```bash
mcp-hub --port 3000 --config path/to/config.json
```

The server outputs JSON-formatted status messages on startup and state changes:

```json
{
  "status": "ready",
  "server_id": "mcp-hub",
  "version": "1.0.0",
  "port": 3000,
  "pid": 12345,
  "servers": [],
  "timestamp": "2024-02-20T05:55:00.000Z"
}
```

## Architecture

### Hub Server Lifecycle

![Hub Lifecycle](public/diagrams/hub-lifecycle.png)

The Hub Server coordinates communication between clients and MCP servers:

1. Starts and connects to configured MCP servers
2. Manages client registrations
3. Routes tool execution and resource requests
4. Handles server monitoring and health checks
5. Performs clean shutdown of all connections

### MCP Server Management

![Server Management Flow](public/diagrams/server-management-flow.png)

The Hub Server actively manages MCP servers through:

1. Configuration-based server initialization
2. Connection and capability discovery
3. Health monitoring and status tracking
4. Automatic reconnection attempts
5. Server state management

### Request Handling

![Request Flow](public/diagrams/request-flow.png)

All client requests follow a standardized flow:

1. Request validation
2. Server status verification
3. Request routing to appropriate MCP server
4. Response handling and error management

### Real-time Updates

The Hub Server provides real-time updates via Server-Sent Events (SSE) at `/api/events`:

```javascript
const eventSource = new EventSource("http://localhost:3000/api/events");

// Event handlers
eventSource.addEventListener("server_info", (e) => {
  // Initial connection info
});

eventSource.addEventListener("server_ready", (e) => {
  // Server started and ready
});

eventSource.addEventListener("server_shutdown", (e) => {
  // Server is shutting down
});

eventSource.addEventListener("client_registered", (e) => {
  // New client connected
});

eventSource.addEventListener("client_unregistered", (e) => {
  // Client disconnected
});
```

#### Event Types

1. **server_info**

```json
{
  "server_id": "mcp-hub",
  "version": "1.0.0",
  "status": "connected",
  "pid": 12345,
  "port": 3000,
  "activeClients": 1,
  "timestamp": "2024-02-20T05:55:00.000Z"
}
```

2. **server_ready**

```json
{
  "status": "ready",
  "server_id": "mcp-hub",
  "version": "1.0.0",
  "port": 3000,
  "pid": 12345,
  "servers": [],
  "timestamp": "2024-02-20T05:55:00.000Z"
}
```

3. **client_registered/unregistered**

```json
{
  "activeClients": 2,
  "clientId": "client_123",
  "timestamp": "2024-02-20T05:55:00.000Z"
}
```

## REST API

### Health and Status

#### Health Check

```bash
GET /api/health
```

Response:

```json
{
  "status": "ok",
  "server_id": "mcp-hub",
  "version": "1.0.0",
  "activeClients": 2,
  "timestamp": "2024-02-20T05:55:00.000Z",
  "servers": []
}
```

#### List MCP Servers

```bash
GET /api/servers
```

#### Get Server Info

```bash
GET /api/servers/:name/info
```

### Client Management

#### Register Client

```bash
POST /api/client/register
{
  "clientId": "unique_client_id"
}
```

#### Unregister Client

```bash
POST /api/client/unregister
{
  "clientId": "unique_client_id"
}
```

### MCP Server Operations

#### Execute Tool

```bash
POST /api/servers/:name/tools
{
  "tool": "tool_name",
  "arguments": {}
}
```

#### Access Resource

```bash
POST /api/servers/:name/resources
{
  "uri": "resource://uri"
}
```

## Configuration

MCP Hub uses a JSON configuration file to define managed servers:

```json
{
  "mcpServers": {
    "example-server": {
      "command": "npx example-mcp-server",
      "args": ["--config", "server-config.json"],
      "env": {
        "API_KEY": "your-api-key"
      },
      "disabled": false
    }
  }
}
```

### Configuration Options

- **command**: Command to start the MCP server
- **args**: Array of command line arguments
- **env**: Environment variables for the server
- **disabled**: Whether the server is disabled (default: false)

## Error Handling

The Hub Server implements comprehensive error handling:

1. **Server Connection Errors**

   - Failed connection attempts
   - Lost connections
   - Capability fetch failures

2. **Request Errors**

   - Invalid request parameters
   - Server not found/available
   - Tool execution failures
   - Resource access failures

3. **Client Management Errors**
   - Registration failures
   - Duplicate registrations
   - Invalid client IDs

## Logging

All server events are logged to `~/.mcp-hub/logs/mcp-hub.log` in JSON format:

```json
{
  "level": "info",
  "message": "Server started",
  "timestamp": "2024-02-20T05:55:00.000Z",
  "port": 3000
}
```

## Requirements

- Node.js >= 18.0.0
- npm >= 9.0.0

## License

MIT License - See LICENSE file for details
