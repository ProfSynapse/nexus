/**
 * IPCTransportManager Unit Tests
 *
 * Tests the per-connection server model that allows multiple IPC clients
 * (Claude Desktop, Cursor, etc.) to connect simultaneously, and verifies
 * proper cleanup on socket disconnect and server stop.
 */

// ============================================================================
// Module Mocks — must come before imports
// ============================================================================

const mockTransportClose = jest.fn().mockResolvedValue(undefined);

jest.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: jest.fn().mockImplementation(() => ({
    close: mockTransportClose,
  })),
}));

jest.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: jest.fn(),
}));

jest.mock('@modelcontextprotocol/sdk/types.js', () => ({
  McpError: class McpError extends Error {
    constructor(public code: number, message: string, public cause?: unknown) {
      super(message);
    }
  },
  ErrorCode: { InternalError: -32603 },
}));

jest.mock('../../src/utils/logger', () => ({
  logger: {
    systemLog: jest.fn(),
    systemError: jest.fn(),
  },
}));

// ============================================================================
// Imports
// ============================================================================

import { IPCTransportManager } from '../../src/server/transport/IPCTransportManager';
import { StdioTransportManager } from '../../src/server/transport/StdioTransportManager';
import { Server as MCPSDKServer } from '@modelcontextprotocol/sdk/server/index.js';
import { ServerConfiguration } from '../../src/server/services/ServerConfiguration';
import { EventEmitter } from 'events';

// ============================================================================
// Mock Factories
// ============================================================================

function createMockConfiguration() {
  return {
    isWindows: jest.fn().mockReturnValue(false),
    getIPCPath: jest.fn().mockReturnValue('/tmp/test-nexus.sock'),
    getServerInfo: jest.fn().mockReturnValue({ name: 'test', version: '1.0' }),
    getServerOptions: jest.fn().mockReturnValue({}),
  } as unknown as ServerConfiguration;
}

function createMockStdioTransportManager() {
  return {
    createSocketTransport: jest.fn().mockReturnValue({
      close: jest.fn().mockResolvedValue(undefined),
    }),
    connectSocketTransport: jest.fn().mockResolvedValue(undefined),
  } as unknown as StdioTransportManager;
}

function createMockPerConnectionServer() {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    setRequestHandler: jest.fn(),
  } as unknown as MCPSDKServer;
}

/**
 * Creates a mock socket (EventEmitter with ReadWriteStream shape).
 */
function createMockSocket() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    destroyed: false,
    destroy: jest.fn(function (this: any) { this.destroyed = true; }),
    writable: true,
    readable: true,
    // Stubs for ReadWriteStream
    write: jest.fn(),
    end: jest.fn(),
    pipe: jest.fn(),
    read: jest.fn(),
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('IPCTransportManager', () => {
  let mockConfig: ReturnType<typeof createMockConfiguration>;
  let mockStdioManager: ReturnType<typeof createMockStdioTransportManager>;

  beforeEach(() => {
    mockConfig = createMockConfiguration();
    mockStdioManager = createMockStdioTransportManager();
    mockTransportClose.mockReset().mockResolvedValue(undefined);
  });

  describe('multi-client connections (with serverFactory)', () => {
    it('should create a per-connection server for each socket', async () => {
      const servers: MCPSDKServer[] = [];
      const serverFactory = jest.fn(() => {
        const server = createMockPerConnectionServer();
        servers.push(server);
        return server;
      });

      const manager = new IPCTransportManager(
        mockConfig as unknown as ServerConfiguration,
        mockStdioManager as unknown as StdioTransportManager,
        serverFactory
      );

      // Simulate two connections
      const socketA = createMockSocket();
      const socketB = createMockSocket();
      (manager as any).handleSocketConnection(socketA);
      (manager as any).handleSocketConnection(socketB);

      // Wait for async connect() calls to resolve
      await flushPromises();

      expect(serverFactory).toHaveBeenCalledTimes(2);
      expect(servers).toHaveLength(2);
      expect((servers[0] as any).connect).toHaveBeenCalledTimes(1);
      expect((servers[1] as any).connect).toHaveBeenCalledTimes(1);
    });

    it('should track active connections and log count', async () => {
      const servers: MCPSDKServer[] = [];
      const serverFactory = jest.fn(() => {
        const server = createMockPerConnectionServer();
        servers.push(server);
        return server;
      });

      const manager = new IPCTransportManager(
        mockConfig as unknown as ServerConfiguration,
        mockStdioManager as unknown as StdioTransportManager,
        serverFactory
      );

      const socketA = createMockSocket();
      const socketB = createMockSocket();
      (manager as any).handleSocketConnection(socketA);
      (manager as any).handleSocketConnection(socketB);
      await flushPromises();

      // Both should be tracked
      const activeConnections = (manager as any).activeConnections as Set<MCPSDKServer>;
      expect(activeConnections.size).toBe(2);
    });

    it('should remove connection and close server on socket close', async () => {
      const servers: MCPSDKServer[] = [];
      const serverFactory = jest.fn(() => {
        const server = createMockPerConnectionServer();
        servers.push(server);
        return server;
      });

      const manager = new IPCTransportManager(
        mockConfig as unknown as ServerConfiguration,
        mockStdioManager as unknown as StdioTransportManager,
        serverFactory
      );

      const socket = createMockSocket();
      (manager as any).handleSocketConnection(socket);
      await flushPromises();

      const activeConnections = (manager as any).activeConnections as Set<MCPSDKServer>;
      expect(activeConnections.size).toBe(1);

      // Simulate socket close
      socket.emit('close');
      await flushPromises();

      expect(activeConnections.size).toBe(0);
      expect((servers[0] as any).close).toHaveBeenCalledTimes(1);
    });

    it('should handle socket end event the same as close', async () => {
      const servers: MCPSDKServer[] = [];
      const serverFactory = jest.fn(() => {
        const server = createMockPerConnectionServer();
        servers.push(server);
        return server;
      });

      const manager = new IPCTransportManager(
        mockConfig as unknown as ServerConfiguration,
        mockStdioManager as unknown as StdioTransportManager,
        serverFactory
      );

      const socket = createMockSocket();
      (manager as any).handleSocketConnection(socket);
      await flushPromises();

      socket.emit('end');
      await flushPromises();

      expect((servers[0] as any).close).toHaveBeenCalledTimes(1);
    });

    it('should not double-close when both end and close fire', async () => {
      const servers: MCPSDKServer[] = [];
      const serverFactory = jest.fn(() => {
        const server = createMockPerConnectionServer();
        servers.push(server);
        return server;
      });

      const manager = new IPCTransportManager(
        mockConfig as unknown as ServerConfiguration,
        mockStdioManager as unknown as StdioTransportManager,
        serverFactory
      );

      const socket = createMockSocket();
      (manager as any).handleSocketConnection(socket);
      await flushPromises();

      // Both events fire (common with TCP sockets)
      socket.emit('end');
      socket.emit('close');
      await flushPromises();

      // The guard flag should prevent double-close
      expect((servers[0] as any).close).toHaveBeenCalledTimes(1);
    });

    it('should destroy socket when server.connect() fails', async () => {
      const failingServer = createMockPerConnectionServer();
      (failingServer as any).connect.mockRejectedValue(new Error('connect failed'));
      const serverFactory = jest.fn(() => failingServer);

      const manager = new IPCTransportManager(
        mockConfig as unknown as ServerConfiguration,
        mockStdioManager as unknown as StdioTransportManager,
        serverFactory
      );

      const socket = createMockSocket();
      (manager as any).handleSocketConnection(socket);
      await flushPromises();

      expect(socket.destroy).toHaveBeenCalled();
    });

    it('should not add connection to active set when connect fails', async () => {
      const failingServer = createMockPerConnectionServer();
      (failingServer as any).connect.mockRejectedValue(new Error('connect failed'));
      const serverFactory = jest.fn(() => failingServer);

      const manager = new IPCTransportManager(
        mockConfig as unknown as ServerConfiguration,
        mockStdioManager as unknown as StdioTransportManager,
        serverFactory
      );

      const socket = createMockSocket();
      (manager as any).handleSocketConnection(socket);
      await flushPromises();

      const activeConnections = (manager as any).activeConnections as Set<MCPSDKServer>;
      expect(activeConnections.size).toBe(0);
    });
  });

  describe('single-client fallback (without serverFactory)', () => {
    it('should delegate to StdioTransportManager when no factory is provided', async () => {
      const manager = new IPCTransportManager(
        mockConfig as unknown as ServerConfiguration,
        mockStdioManager as unknown as StdioTransportManager
        // no serverFactory
      );

      const socket = createMockSocket();
      (manager as any).handleSocketConnection(socket);
      await flushPromises();

      expect((mockStdioManager as any).createSocketTransport).toHaveBeenCalledWith(socket, socket);
      expect((mockStdioManager as any).connectSocketTransport).toHaveBeenCalledTimes(1);
    });
  });

  describe('stopTransport', () => {
    it('should close all active per-connection servers on stop', async () => {
      const servers: MCPSDKServer[] = [];
      const serverFactory = jest.fn(() => {
        const server = createMockPerConnectionServer();
        servers.push(server);
        return server;
      });

      const manager = new IPCTransportManager(
        mockConfig as unknown as ServerConfiguration,
        mockStdioManager as unknown as StdioTransportManager,
        serverFactory
      );

      // Simulate starting the IPC server by setting internal state
      (manager as any).ipcServer = {
        close: jest.fn(),
      };
      (manager as any).isRunning = true;

      // Create two connections
      const socketA = createMockSocket();
      const socketB = createMockSocket();
      (manager as any).handleSocketConnection(socketA);
      (manager as any).handleSocketConnection(socketB);
      await flushPromises();

      expect(servers).toHaveLength(2);
      const activeConnections = (manager as any).activeConnections as Set<MCPSDKServer>;
      expect(activeConnections.size).toBe(2);

      // Stop the transport
      await manager.stopTransport();

      // All per-connection servers should be closed
      expect((servers[0] as any).close).toHaveBeenCalled();
      expect((servers[1] as any).close).toHaveBeenCalled();
      expect(activeConnections.size).toBe(0);
    });

    it('should handle errors from closing per-connection servers', async () => {
      const failingClose = createMockPerConnectionServer();
      (failingClose as any).close.mockRejectedValue(new Error('close failed'));
      const serverFactory = jest.fn(() => failingClose);

      const manager = new IPCTransportManager(
        mockConfig as unknown as ServerConfiguration,
        mockStdioManager as unknown as StdioTransportManager,
        serverFactory
      );

      (manager as any).ipcServer = { close: jest.fn() };
      (manager as any).isRunning = true;

      const socket = createMockSocket();
      (manager as any).handleSocketConnection(socket);
      await flushPromises();

      // Should not throw even though close() rejects
      await expect(manager.stopTransport()).resolves.toBeUndefined();
    });

    it('should be a no-op when server is not running', async () => {
      const manager = new IPCTransportManager(
        mockConfig as unknown as ServerConfiguration,
        mockStdioManager as unknown as StdioTransportManager
      );

      // No ipcServer set
      await expect(manager.stopTransport()).resolves.toBeUndefined();
    });
  });
});

// ============================================================================
// Helpers
// ============================================================================

/**
 * Flush microtask queue to allow pending promise callbacks to execute.
 */
function flushPromises(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}
