/**
 * Location: /src/agents/memoryManager/services/ValidationService.ts
 * Purpose: Consolidated validation service with delegated validators
 * Refactored to use extracted validators following SOLID principles
 *
 * Used by: All memory manager modes for service access and validation
 */

import { App } from 'obsidian';
import { MemoryService } from "./MemoryService";
import { WorkspaceService } from "../../../services/WorkspaceService";
import { StateValidator } from '../validators/StateValidator';
import { ValidationError } from '../validators/ValidationTypes';
import {
  ServiceAccessor,
  ServiceAccessResult,
  ServiceIntegrationConfig,
  ServiceStatus
} from './ServiceAccessor';

/**
 * Consolidated validation service for memory manager operations
 */
export class ValidationService {
  private static readonly DEFAULT_CONFIG: ServiceIntegrationConfig = {
    maxRetries: 3,
    retryDelayMs: 500,
    timeoutMs: 5000,
    enableHealthCheck: true,
    fallbackBehavior: 'warn',
    logLevel: 'warn'
  };

  private serviceAccessor: ServiceAccessor;

  constructor(app: App, config: Partial<ServiceIntegrationConfig> = {}) {
    const fullConfig = { ...ValidationService.DEFAULT_CONFIG, ...config };
    this.serviceAccessor = new ServiceAccessor(app, fullConfig);
  }

  /**
   * Get memory service with robust error handling and retry logic
   */
  async getMemoryService(): Promise<ServiceAccessResult<MemoryService>> {
    return this.serviceAccessor.getService<MemoryService>('memoryService', 'MemoryService');
  }

  /**
   * Get workspace service with robust error handling and retry logic
   */
  async getWorkspaceService(): Promise<ServiceAccessResult<WorkspaceService>> {
    return this.serviceAccessor.getService<WorkspaceService>('workspaceService', 'WorkspaceService');
  }

  /**
   * Get memory service synchronously (for immediate availability checks)
   */
  getMemoryServiceSync(): ServiceAccessResult<MemoryService> {
    return this.serviceAccessor.getServiceSync<MemoryService>('memoryService', 'MemoryService');
  }

  /**
   * Get workspace service synchronously (for immediate availability checks)
   */
  getWorkspaceServiceSync(): ServiceAccessResult<WorkspaceService> {
    return this.serviceAccessor.getServiceSync<WorkspaceService>('workspaceService', 'WorkspaceService');
  }

  /**
   * Validate state creation parameters
   */
  validateStateCreationParams(params: any): ValidationError[] {
    return StateValidator.validateCreationParams(params);
  }

  /**
   * Reset service status (for testing or manual intervention)
   */
  resetServiceStatus(serviceName?: string): void {
    this.serviceAccessor.resetServiceStatus(serviceName);
  }

  /**
   * Get comprehensive service diagnostics
   */
  getDiagnostics(): Record<string, ServiceStatus> {
    return this.serviceAccessor.getDiagnostics();
  }
}

/**
 * Default service integration instance factory
 * Creates a standard service integration with recommended settings
 */
export function createServiceIntegration(app: App, config?: Partial<ServiceIntegrationConfig>): ValidationService {
  return new ValidationService(app, {
    maxRetries: 2,
    retryDelayMs: 300,
    timeoutMs: 3000,
    enableHealthCheck: true,
    fallbackBehavior: 'warn',
    logLevel: 'warn',
    ...config
  });
}

// Re-export types for backward compatibility
export type {
  ServiceStatus,
  ServiceAccessResult,
  ServiceIntegrationConfig,
  ValidationError
};
