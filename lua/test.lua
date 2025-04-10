local uv = vim.loop

-- Create pipes for stdio
local function create_stdio_pipes()
	return uv.new_pipe(), uv.new_pipe(), uv.new_pipe()
end

-- Function to spawn detached process
local function spawn_detached_process()
	local stdin, stdout, stderr = create_stdio_pipes()

	-- Disable stdio inheritance
	uv.disable_stdio_inheritance()

	-- Spawn tail as a test process
	local handle, pid = uv.spawn("tail", {
		args = { "-f", "/dev/null" },
		stdio = { stdin, stdout, stderr },
		detached = true, -- Run the process in a detached state
	}, function(code, signal)
		print("Process exited with code:", code, "signal:", signal)
	end)

	if not handle then
		error("Failed to spawn process")
		return
	end

	-- Handle stdout
	uv.read_start(stdout, function(err, data)
		assert(not err, err)
		if data then
			print("stdout:", data)
		end
	end)

	-- Handle stderr
	uv.read_start(stderr, function(err, data)
		assert(not err, err)
		if data then
			print("stderr:", data)
		end
	end)

	-- Unref the process to let neovim exit without killing it
	uv.unref(handle)

	print("Process started with PID:", pid)

	return handle, pid
end

-- Function to spawn Express server
local function spawn_server()
	local stdin, stdout, stderr = create_stdio_pipes()

	-- Disable stdio inheritance
	uv.disable_stdio_inheritance()

	-- Spawn node server
	local handle, pid = uv.spawn("node", {
		args = { "/home/ubuntu/mcp-hub/test-server.js" },
		stdio = { stdin, stdout, stderr },
		detached = true,
		env = {
			PORT = "3001",
			NODE_NO_WARNINGS = "1",
		},
	}, function(code, signal)
		print("Server exited with code:", code, "signal:", signal)
	end)

	if not handle then
		error("Failed to spawn server")
		return
	end

	-- Handle stdout
	uv.read_start(stdout, function(err, data)
		assert(not err, err)
		if data then
			print("stdout:", data)
		end
	end)

	-- Handle stderr
	uv.read_start(stderr, function(err, data)
		assert(not err, err)
		if data then
			print("stderr:", data)
		end
	end)

	-- Unref the process
	uv.unref(handle)

	print("Server started with PID:", pid)

	return handle, pid
end

-- Function to check if process is running
local function check_process(pid)
	if not pid then
		return false
	end
	local success = uv.kill(pid, 0) -- Signal 0 just checks if process exists
	return success == 0
end

-- Function to check server health
local function check_server()
	local curl = vim.fn.system("curl -s http://localhost:3001/health")
	if vim.v.shell_error == 0 then
		print("Server response:", curl)
		return true
	end
	print("Server not responding")
	return false
end

-- Test harness for tail process
local function run_test()
	print("Starting detached process test...")

	local handle, pid = spawn_detached_process()
	if not handle or not pid then
		print("Failed to start process")
		return
	end

	-- Store PID in a file for later reference
	vim.fn.writefile({ tostring(pid) }, "/tmp/test.pid")

	-- Wait a bit and check if process is running
	vim.defer_fn(function()
		local is_running = check_process(pid)
		print("Process state after 2s:", is_running and "RUNNING" or "NOT RUNNING")
		print("\nTest instructions:")
		print("1. Tail process running with PID:", pid)
		print("2. PID saved to /tmp/test.pid")
		print("3. Close neovim")
		print("4. Check process: ps aux | grep", pid)
		print("5. Kill when done: kill $(cat /tmp/test.pid)")
	end, 2000)
end

-- Test harness for Express server
local function run_server_test()
	print("Starting Express server test...")

	local handle, pid = spawn_server()
	if not handle or not pid then
		print("Failed to start server")
		return
	end

	-- Store PID in a file for later reference
	vim.fn.writefile({ tostring(pid) }, "/tmp/test-server.pid")

	-- Wait and verify server
	vim.defer_fn(function()
		local is_running = check_process(pid)
		print("Process state after 2s:", is_running and "RUNNING" or "NOT RUNNING")

		if is_running then
			print("Testing server response...")
			check_server()
		end

		print("\nTest instructions:")
		print("1. Express server running on port 3001 with PID:", pid)
		print("2. PID saved to /tmp/test-server.pid")
		print("3. Monitor process:")
		print('   watch -n1 "ps f -o user,pid,ppid,state,%cpu,%mem,start,time,cmd | grep -v grep | grep node"')
		print("4. Test server: curl http://localhost:3001/health")
		print("5. Close neovim")
		print("6. Test again after neovim closes")
		print("7. Kill when done: kill $(cat /tmp/test-server.pid)")
	end, 2000)
end

-- Function to kill the test process
local function kill_test()
	local pid_file = "/tmp/test.pid"
	if vim.fn.filereadable(pid_file) == 1 then
		local pid = vim.fn.readfile(pid_file)[1]
		if pid then
			uv.kill(tonumber(pid), "SIGTERM")
			vim.fn.delete(pid_file)
			print("Sent SIGTERM to process", pid)
		end
	end
end

-- Function to kill the server
local function kill_server()
	local pid_file = "/tmp/test-server.pid"
	if vim.fn.filereadable(pid_file) == 1 then
		local pid = vim.fn.readfile(pid_file)[1]
		if pid then
			uv.kill(tonumber(pid), "SIGTERM")
			vim.fn.delete(pid_file)
			print("Sent SIGTERM to server", pid)
		end
	end
end

return {
	-- Original tail test functions
	run_test = run_test,
	spawn_detached = spawn_detached_process,
	check_process = check_process,
	kill = kill_test,

	-- New Express server test functions
	run_server_test = run_server_test,
	spawn_server = spawn_server,
	check_server = check_server,
	kill_server = kill_server,
}
