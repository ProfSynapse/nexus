/**
 * StdioTransportManager Unit Tests
 *
 * Tests the defensive close-before-reconnect logic added to
 * connectSocketTransport() to prevent the "Already connected to a
 * transport" race condition when a new IPC connection arrives before
 * the previous socket's async close/end handler has run.
 */

// ============================================================================
// Module Mocks — must come before imports
// ============================================================================

jest.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    setRequestHandler: jest.fn(),
  })),
}));

jest.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: jest.fn().mockImplementation(() => ({
    close: jest.fn().mockResolvedValue(undefined),
  })),
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

import { StdioTransportManager } from '../../src/server/transport/StdioTransportManager';
import { Server as MCPSDKServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// ============================================================================
// Mock Factories
// ============================================================================

function createMockServer() {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    setRequestHandler: jest.fn(),
  };
}

function createMockTransport() {
  return {
    close: jest.fn().mockResolvedValue(undefined),
  } as unknown as StdioServerTransport;
}

// ============================================================================
// Tests
// ============================================================================

describe('StdioTransportManager', () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let manager: StdioTransportManager;

  beforeEach(() => {
    mockServer = createMockServer();
    manager = new StdioTransportManager(mockServer as unknown as MCPSDKServer);
  });

  describe('connectSocketTransport', () => {
    it('should connect a transport to the server', async () => {
      const transport = createMockTransport();

      await manager.connectSocketTransport(transport);

      expect(mockServer.connect).toHaveBeenCalledWith(transport);
      expect(mockServer.connect).toHaveBeenCalledTimes(1);
    });

    it('should close previous transport before connecting new one', async () => {
      const transportA = createMockTransport();
      const transportB = createMockTransport();

      await manager.connectSocketTransport(transportA);
      await manager.connectSocketTransport(transportB);

      // transportA should have been closed before transportB was connected
      expect(transportA.close).toHaveBeenCalledTimes(1);
      expect(mockServer.connect).toHaveBeenCalledTimes(2);
      expect(mockServer.connect).toHaveBeenNthCalledWith(1, transportA);
      expect(mockServer.connect).toHaveBeenNthCalledWith(2, transportB);
    });

    it('should handle errors from closing previous transport gracefully', async () => {
      const transportA = createMockTransport();
      (transportA.close as jest.Mock).mockRejectedValue(new Error('already closed'));
      const transportB = createMockTransport();

      await manager.connectSocketTransport(transportA);
      // Should not throw even though transportA.close() rejects
      await manager.connectSocketTransport(transportB);

      expect(mockServer.connect).toHaveBeenCalledTimes(2);
    });

    it('should throw McpError when server.connect fails', async () => {
      const transport = createMockTransport();
      mockServer.connect.mockRejectedValue(new Error('Already connected to a transport'));

      await expect(manager.connectSocketTransport(transport)).rejects.toThrow(
        'Failed to connect socket transport'
      );
    });

    it('should clear activeSocketTransport on connect failure', async () => {
      const transportA = createMockTransport();
      const transportB = createMockTransport();

      // First connect succeeds
      await manager.connectSocketTransport(transportA);

      // Second connect fails
      mockServer.connect.mockRejectedValueOnce(new Error('connect failed'));
      await expect(manager.connectSocketTransport(transportB)).rejects.toThrow();

      // Third connect should NOT try to close transportB (it was never active)
      mockServer.connect.mockResolvedValueOnce(undefined);
      const transportC = createMockTransport();
      await manager.connectSocketTransport(transportC);

      // transportA was closed when transportB came in, transportB was never set active
      expect(transportA.close).toHaveBeenCalledTimes(1);
      expect(transportB.close).not.toHaveBeenCalled();
    });

    it('should not close anything on first connection', async () => {
      const transport = createMockTransport();
      await manager.connectSocketTransport(transport);

      // No previous transport to close
      expect(transport.close).not.toHaveBeenCalled();
    });
  });
});
