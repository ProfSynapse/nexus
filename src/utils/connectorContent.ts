/**
 * Auto-generated file containing the embedded connector.js content.
 * This is used by ConnectorEnsurer to recreate connector.js if it's missing.
 *
 * DO NOT EDIT MANUALLY - This file is regenerated during the build process.
 * To update, modify connector.ts and rebuild.
 *
 * Generated: 2026-01-23T11:50:26.126Z
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
 * 2. Sets up error handling (silent for normal "waiting" errors)
 * 3. Implements infinite retry with capped exponential backoff (max 30s)
 * 4. Automatically connects when Obsidian becomes available
 */
function connectWithRetry() {
    var ipcPath = getIPCPath();
    var isFirstAttempt = retryCount === 0;
    // Track whether this socket ever successfully connected
    var hasConnected = false;
    // Only log on the very first attempt
    if (isFirstAttempt) {
        process.stderr.write("Connecting to MCP server at: ".concat(ipcPath, "\\n"));
    }
    try {
        var socket = (0, net_1.createConnection)(ipcPath);
        // Pipe stdin/stdout to/from the socket
        process.stdin.pipe(socket);
        socket.pipe(process.stdout);
        // Error handling - silent for normal "waiting" errors, verbose for unexpected errors
        socket.on('error', function (err) {
            // Cast error to NodeJS.ErrnoException to access the code property
            var nodeErr = err;
            var isWaitingError = nodeErr.code === 'ENOENT' || nodeErr.code === 'ECONNREFUSED';
            // Only log unexpected errors (not normal "Obsidian not running" cases)
            if (!isWaitingError) {
                process.stderr.write("ERROR: IPC connection error: ".concat(err, "\\n"));
            }
            else if (isFirstAttempt) {
                // On first attempt only, note that we're waiting
                process.stderr.write("Obsidian not available yet, waiting silently...\\n");
            }
            // Always retry with exponential backoff (capped at 30s)
            retryCount++;
            var retryDelay = calculateBackoff(retryCount);
            setTimeout(connectWithRetry, retryDelay);
        });
        socket.on('connect', function () {
            hasConnected = true;
            process.stderr.write('Connected to MCP server successfully\\n');
            // Reset retry count on successful connection
            retryCount = 0;
        });
        socket.on('close', function () {
            if (hasConnected) {
                // Only log and exit if we actually had a connection
                process.stderr.write('Connection to MCP server closed\\n');
                process.exit(0);
            }
            // If we never connected, the error handler will schedule a retry
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
