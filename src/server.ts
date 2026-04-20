/**
 * server.ts - Refactored following SOLID principles
 * Main export for backward compatibility
 */

// Export the refactored MCPServer as the main MCPServer
export { MCPServer } from './server/MCPServer';

// Export specialized services for direct use if needed
export { ServerConfiguration } from './server/services/ServerConfiguration';
export { AgentRegistry } from './server/services/AgentRegistry';
export { StdioTransportManager } from './server/transport/StdioTransportManager';
export { IPCTransportManager } from './server/transport/IPCTransportManager';
export { RequestHandlerFactory } from './server/handlers/RequestHandlerFactory';
export { ServerLifecycleManager } from './server/lifecycle/ServerLifecycleManager';
export { AgentExecutionManager } from './server/execution/AgentExecutionManager';

// Export types if needed
export type { ServerConfigurationOptions } from './server/services/ServerConfiguration';