-- Example Neovim integration for MCP Hub
local curl = require("plenary.curl")
local Job = require("plenary.job")

-- Initialize MCPHub client
local MCPHubClient = {}
MCPHubClient.__index = MCPHubClient

function MCPHubClient:new(opts)
    local self = setmetatable({}, MCPHubClient)
    self.port = opts.port or 3000
    self.config = opts.config
    self.ready = false
    self.is_owner = false
    self.server_job = nil
    -- Generate unique client ID
    self.client_id = string.format("%s_%s_%s", vim.fn.getpid(), vim.fn.localtime(), vim.fn.rand())

    -- Register cleanup on exit
    vim.api.nvim_create_autocmd("VimLeavePre", {
        callback = function()
            self:stop()
        end
    })

    return self
end

-- Make API request with error handling
function MCPHubClient:api_request(method, path, body)
    local url = string.format("http://localhost:%d/api/%s", self.port, path)
    local opts = {
        method = method,
        timeout = 3000, -- 3 second timeout
        headers = {
            ["Content-Type"] = "application/json"
        }
    }

    if body then
        opts.body = vim.fn.json_encode(body)
    end

    opts.url = url

    -- Make request with protected call
    local ok, response = pcall(curl.request, opts)
    if not ok then
        return nil, "Network error: Request failed"
    end

    -- Handle response
    if not response.body then
        return nil, "Empty response"
    end

    local decode_ok, decoded = pcall(vim.fn.json_decode, response.body)
    if not decode_ok then
        return nil, "Invalid JSON response"
    end

    return decoded
end

-- Check server health
function MCPHubClient:check_server()
    local response = self:api_request("GET", "health")
    if not response then
        return false
    end
    return response.status == "ok"
end

-- Register with server
function MCPHubClient:register()
    return self:api_request("POST", "client/register", {
        clientId = self.client_id
    })
end

-- Start server or connect to existing
function MCPHubClient:start()
    -- Check if server is already running
    if self:check_server() then
        vim.notify("MCP Hub server already running", vim.log.levels.INFO)
        -- Just register client
        if self:register() then
            self.ready = true
            vim.notify("Connected to MCP Hub", vim.log.levels.INFO)
            return true
        end
        return false
    end

    -- We're starting the server, mark as owner
    self.is_owner = true
    self.server_job = Job:new({
        command = "mcp-hub",
        args = {"--port", tostring(self.port), "--config", self.config},
        on_stdout = function(_, data)
            -- Parse JSON startup message
            if data and data:match("{.*}") then
                local ok, parsed = pcall(vim.fn.json_decode, data)
                if ok and parsed.status == "ready" then
                    -- Server started successfully
                    vim.schedule(function()
                        -- Register client
                        if self:register() then
                            self.ready = true
                            vim.notify("MCP Hub server started and ready", vim.log.levels.INFO)
                        end
                    end)
                end
            end
        end,
        on_stderr = function(_, data)
            if data then
                vim.schedule(function()
                    vim.notify("MCP Hub error: " .. data, vim.log.levels.ERROR)
                end)
            end
        end,
        on_exit = function(_, code)
            if code ~= 0 then
                vim.schedule(function()
                    vim.notify(string.format("MCP Hub exited with code %d", code), vim.log.levels.ERROR)
                end)
            end
            self.ready = false
            self.server_job = nil
        end
    })

    self.server_job:start()
end

-- Stop client and cleanup
function MCPHubClient:stop()
    if self.ready then
        -- Unregister client
        self:api_request("POST", "client/unregister", {
            clientId = self.client_id
        })
    end

    self.ready = false
    self.is_owner = false
end

-- Get server status
function MCPHubClient:get_status()
    local health = self:api_request("GET", "health")
    return {
        ready = self.ready,
        is_owner = self.is_owner,
        activeClients = health and health.activeClients or 0,
        servers = health and health.servers or {}
    }
end

-- Example setup function
function setup(opts)
    -- Create new instance
    local client = MCPHubClient:new(opts)

    -- Create status command
    vim.api.nvim_create_user_command("MCPStatus", function()
        local status = client:get_status()
        local msg = string.format(
            "MCP Hub Status:\n- Ready: %s\n- Owner: %s\n- Active Clients: %d\n- Available Servers: %d",
            status.ready and "Yes" or "No", status.is_owner and "Yes" or "No", status.activeClients,
            #(status.servers or {}))
        vim.notify(msg, vim.log.levels.INFO, {
            title = "MCP Hub"
        })
    end, {})

    return client
end

return {
    setup = setup
}
