/**
 * Auto-generated file containing the embedded connector.js content.
 * This is used by ConnectorEnsurer to recreate connector.js if it's missing.
 *
 * DO NOT EDIT MANUALLY - This file is regenerated during the build process.
 * To update, modify connector.ts and rebuild.
 *
 * Generated: 2026-01-04T14:25:04.117Z
 */

export const CONNECTOR_JS_CONTENT = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var net_1 = require("net");
var path_1 = require("path");
/**
 * Creates a connection to the MCP server
 * This connector is used by Claude Desktop to communicate with our Obsidian plugin
 * Uses named pipes on Windows and Unix domain sockets on macOS/Linux
 *
 * The IPC path now includes the vault name to support multiple vaults
 */
/**
 * Sanitizes a vault name for use in identifiers, filenames, and configuration keys
 *
 * This function standardizes vault names by:
 * - Converting to lowercase
 * - Removing special characters (keeping only alphanumeric, spaces, and hyphens)
 * - Replacing spaces with hyphens
 * - Normalizing multiple consecutive hyphens to a single hyphen
 *
 * @param vaultName - The original vault name to sanitize
 * @returns A sanitized version of the vault name suitable for use in identifiers
 */
var sanitizeVaultName = function (vaultName) {
    if (!vaultName)
        return '';
    return vaultName
        .toLowerCase() // Convert to lowercase
        .replace(/[^\\w\\s-]/g, '') // Remove special characters (keep alphanumeric, spaces, hyphens)
        .replace(/\\s+/g, '-') // Replace spaces with hyphens
        .replace(/-+/g, '-'); // Replace multiple consecutive hyphens with a single one
};
/**
 * Extracts the vault name from the script execution path
 *
 * The script path follows the pattern:
 * /path/to/vault_name/.obsidian/plugins/nexus/connector.js
 *
 * We need to go up 4 levels from the script path to reach the vault name:
 * 1. dirname(scriptPath) -> /path/to/vault_name/.obsidian/plugins/nexus
 * 2. dirname() -> /path/to/vault_name/.obsidian/plugins
 * 3. dirname() -> /path/to/vault_name/.obsidian
 * 4. dirname() -> /path/to/vault_name
 * 5. basename() -> vault_name
 *
 * @returns The extracted vault name or empty string if not found
 */
var extractVaultName = function () {
    try {
        // Get the script path from process.argv
        var scriptPath = process.argv[1];
        if (!scriptPath) {
            process.stderr.write('DEBUG: Script path is undefined or empty\\n');
            return '';
        }
        process.stderr.write("DEBUG: Script path: ".concat(scriptPath, "\\n"));
        // Go up 4 levels in the directory hierarchy to reach the vault name
        // 1. nexus plugin directory
        var pluginDir = (0, path_1.dirname)(scriptPath);
        process.stderr.write("DEBUG: Plugin directory: ".concat(pluginDir, "\\n"));
        // 2. plugins directory
        var pluginsDir = (0, path_1.dirname)(pluginDir);
        process.stderr.write("DEBUG: Plugins directory: ".concat(pluginsDir, "\\n"));
        // 3. .obsidian directory
        var obsidianDir = (0, path_1.dirname)(pluginsDir);
        process.stderr.write("DEBUG: Obsidian directory: ".concat(obsidianDir, "\\n"));
        // 4. vault directory (parent of .obsidian)
        var vaultDir = (0, path_1.dirname)(obsidianDir);
        process.stderr.write("DEBUG: Vault directory: ".concat(vaultDir, "\\n"));
        // The vault name is the basename of the vault directory
        var vaultName = (0, path_1.basename)(vaultDir);
        process.stderr.write("DEBUG: Extracted vault name: ".concat(vaultName, "\\n"));
        if (!vaultName) {
            process.stderr.write('WARNING: Extracted vault name is empty\\n');
            return '';
        }
        return vaultName;
    }
    catch (error) {
        process.stderr.write("ERROR: Failed to extract vault name: ".concat(error, "\\n"));
        process.stderr.write("ERROR: Stack trace: ".concat(error.stack, "\\n"));
        return '';
    }
};
/**
 * Gets the IPC path with vault name included
 *
 * This creates a unique IPC path for each vault to prevent conflicts
 * between different vault instances.
 *
 * @returns The IPC path string with vault name included
 */
var getIPCPath = function () {
    // Extract and sanitize the vault name
    var vaultName = extractVaultName();
    var sanitizedVaultName = sanitizeVaultName(vaultName);
    // Add the sanitized vault name to the IPC path
    return process.platform === 'win32'
        ? "\\\\\\\\.\\\\pipe\\\\nexus_mcp_".concat(sanitizedVaultName)
        : "/tmp/nexus_mcp_".concat(sanitizedVaultName, ".sock");
};
// Maximum number of connection attempts
var MAX_RETRIES = 3;
var retryCount = 0;
/**
 * Attempts to connect to the MCP server with retry logic
 *
 * This function:
 * 1. Creates a connection to the IPC path
 * 2. Sets up error handling with detailed diagnostics
 * 3. Implements retry logic with backoff
 * 4. Provides helpful error messages for troubleshooting
 */
function connectWithRetry() {
    var ipcPath = getIPCPath();
    process.stderr.write("Attempting to connect to MCP server (attempt ".concat(retryCount + 1, "/").concat(MAX_RETRIES, ")...\\n"));
    process.stderr.write("Using IPC path: ".concat(ipcPath, "\\n"));
    try {
        var socket = (0, net_1.createConnection)(ipcPath);
        // Pipe stdin/stdout to/from the socket
        process.stdin.pipe(socket);
        socket.pipe(process.stdout);
        // Enhanced error handling with detailed diagnostics
        socket.on('error', function (err) {
            var errorMessage = "IPC connection error: ".concat(err);
            process.stderr.write("ERROR: ".concat(errorMessage, "\\n"));
            // Provide specific guidance based on error type
            // Cast error to NodeJS.ErrnoException to access the code property
            var nodeErr = err;
            if (nodeErr.code === 'ENOENT') {
                process.stderr.write("The IPC path does not exist. This may indicate:\\n");
                process.stderr.write("1. Obsidian is not running\\n");
                process.stderr.write("2. The Nexus plugin is not enabled\\n");
                process.stderr.write("3. The vault name extraction failed (extracted: \\"".concat(sanitizeVaultName(extractVaultName()), "\\")\\n"));
            }
            else if (nodeErr.code === 'ECONNREFUSED') {
                process.stderr.write("Connection refused. The server may have stopped or is not listening.\\n");
            }
            if (retryCount < MAX_RETRIES - 1) {
                retryCount++;
                var retryDelay = 1000 * retryCount; // Increasing backoff
                process.stderr.write("Retrying connection in ".concat(retryDelay / 1000, " second(s)...\\n"));
                setTimeout(connectWithRetry, retryDelay);
            }
            else {
                process.stderr.write("Maximum retry attempts reached. Please ensure:\\n");
                process.stderr.write("1. Obsidian is running\\n");
                process.stderr.write("2. The Nexus plugin is enabled\\n");
                process.stderr.write("3. The plugin settings are correctly configured\\n");
                process.stderr.write("4. Check the extracted vault name: \\"".concat(extractVaultName(), "\\"\\n"));
                process.exit(1);
            }
        });
        socket.on('connect', function () {
            process.stderr.write('Connected to MCP server successfully\\n');
        });
        socket.on('close', function () {
            process.stderr.write('Connection to MCP server closed\\n');
            process.exit(0);
        });
    }
    catch (error) {
        // Provide more detailed error information
        process.stderr.write("ERROR: Failed to create connection: ".concat(error, "\\n"));
        // Add stack trace for debugging
        if (error instanceof Error && error.stack) {
            process.stderr.write("Stack trace: ".concat(error.stack, "\\n"));
        }
        // Log the IPC path that was being used
        process.stderr.write("Was attempting to connect to: ".concat(getIPCPath(), "\\n"));
        process.stderr.write("Extracted vault name: \\"".concat(extractVaultName(), "\\"\\n"));
        process.exit(1);
    }
}
// Start the connection process
connectWithRetry();
`;
