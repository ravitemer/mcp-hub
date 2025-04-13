# Troubleshooting Guide

## MCP Inspector

Make sure first a server is working properly using mcp-inspector. 

```bash
npx @modelcontextprotocol/inspector command arg1 arg2
```
You need python, nodejs, uvx(astral-uv), and npm installed along with any server specific dependencies.

Find out more at [mcp-inspector](https://github.com/modelcontextprotocol/inspector).

## File Watching Issues

MCP Hub uses chokidar for reliable file watching across different editors and platforms. If you experience issues with file watching:

### Editor Settings
- In Neovim:
  ```
  :set backupcopy?  (Should be 'auto')
  :set backup?      (Should be 'nobackup')
  :set writebackup? (Consider setting to 'nowritebackup')
  ```
### File Permissions
1. Verify that:
   - The config file has proper read permissions
   - The directory containing the config file is accessible
   - You have write permissions if making changes

### System Limits (Linux)
1. Check file watch limits:
   ```bash
   cat /proc/sys/fs/inotify/max_user_watches
   ```
2. If too low, increase them:
   ```bash
   echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf
   sudo sysctl -p
   ```
