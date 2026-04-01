/**
 * Auto-generated file containing the embedded connector.js content.
 * This is used by ConnectorEnsurer to recreate connector.js if it's missing.
 *
 * DO NOT EDIT MANUALLY - This file is regenerated during the build process.
 * To update, modify connector.ts and rebuild.
 *
 * Generated: 2026-04-01T15:09:08.688Z
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
            return '';
        }
        // Go up 4 levels in the directory hierarchy to reach the vault name
        // 1. nexus plugin directory
        var pluginDir = (0, path_1.dirname)(scriptPath);
        // 2. plugins directory
        var pluginsDir = (0, path_1.dirname)(pluginDir);
        // 3. .obsidian directory
        var obsidianDir = (0, path_1.dirname)(pluginsDir);
        // 4. vault directory (parent of .obsidian)
        var vaultDir = (0, path_1.dirname)(obsidianDir);
        // The vault name is the basename of the vault directory
        var vaultName = (0, path_1.basename)(vaultDir);
        return vaultName || '';
    }
    catch (error) {
        // Silent failure - will use empty vault name
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
// Retry configuration
var MAX_BACKOFF_MS = 30000; // Cap backoff at 30 seconds
var retryCount = 0;
/**
 * Calculates the backoff delay using exponential backoff with a cap
 *
 * @param attempt - The current retry attempt number (0-indexed)
 * @returns The delay in milliseconds (capped at MAX_BACKOFF_MS)
 */
function calculateBackoff(attempt) {
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s, 30s, ...
    var exponentialDelay = 1000 * Math.pow(2, attempt);
    return Math.min(MAX_BACKOFF_MS, exponentialDelay);
}
/**
 * Attempts to connect to the MCP server with infinite retry logic
 *
 * This function:
 * 1. Creates a connection to the IPC path
 * 2. Sets up error handling (completely silent for normal "waiting" errors)
 * 3. Implements infinite retry with capped exponential backoff (max 30s)
 * 4. Automatically connects when Obsidian becomes available
 *
 * Note: This connector is completely silent during normal operation to avoid
 * showing error notifications in Claude Desktop. stderr output is treated as
 * error notifications by Claude Desktop.
 */
function connectWithRetry() {
    var ipcPath = getIPCPath();
    // Track whether this socket ever successfully connected
    var hasConnected = false;
    try {
        var socket_1 = (0, net_1.createConnection)(ipcPath);
        // Pipe stdin/stdout ONLY after connection is confirmed
        socket_1.on('connect', function () {
            hasConnected = true;
            retryCount = 0;
            process.stdin.pipe(socket_1);
            socket_1.pipe(process.stdout);
        });
        // Error handling - completely silent for expected connection errors
        socket_1.on('error', function (err) {
            var nodeErr = err;
            var isWaitingError = nodeErr.code === 'ENOENT' || nodeErr.code === 'ECONNREFUSED';
            if (!isWaitingError) {
                // Non-expected errors - still silent to avoid Claude Desktop notifications
            }
            retryCount++;
            var retryDelay = calculateBackoff(retryCount);
            setTimeout(connectWithRetry, retryDelay);
        });
        socket_1.on('close', function () {
            // Unpipe to prevent stdin consumption by dead socket
            process.stdin.unpipe(socket_1);
            if (hasConnected) {
                retryCount = 0;
                setTimeout(connectWithRetry, 1000);
            }
            // If we never connected, the error handler will schedule a retry
        });
    }
    catch (error) {
        // Only exit on catastrophic errors (shouldn't happen in normal operation)
        // Be silent even here - user sees MCP server as "disconnected" in Claude Desktop
        process.exit(1);
    }
}
// Start the connection process
connectWithRetry();
`;
