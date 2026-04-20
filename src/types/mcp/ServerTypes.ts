/**
 * MCP Server-related Types
 * Extracted from types.ts for better organization
 */

import { PluginManifest } from 'obsidian';
import { IAgent } from '../../agents/interfaces/IAgent';

/**
 * Server status enum
 */
export type ServerStatus = 'initializing' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

/**
 * MCP Server interface
 */
export interface IMCPServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getStatus(): ServerStatus;
  registerAgent(agent: IAgent): void;
}

/**
 * Mutual TLS Options
 */
export interface MutualTLSOptions {
  certPath: string;
  keyPath: string;
  caPath?: string;
}

/**
 * Server State
 */
export interface ServerState {
  running: boolean;
  port: number;
  socketPath?: string;
  protocol: 'http' | 'unix';
  startTime?: Date;
  totalRequests: number;
  clientsConnected: number;
  lastError?: string;
  manifest: PluginManifest;
}