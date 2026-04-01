/**
 * Location: /src/agents/memoryManager/utils/ServiceIntegration.ts
 * Purpose: Robust service integration patterns for memory manager operations
 * 
 * This utility provides standardized service access patterns with:
 * - Consistent error handling and logging
 * - Service availability validation
 * - Graceful fallback mechanisms
 * - Retry logic and timeout handling
 * - Health monitoring and diagnostics
 * 
 * Used by: All workspace and state management modes for reliable service access
 */

import { App } from 'obsidian';
import { MemoryService } from "../services/MemoryService";
import { WorkspaceService } from '../../../services/WorkspaceService';
import { getErrorMessage } from '../../../utils/errorUtils';
import { getAllPluginIds } from '../../../constants/branding';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import type { NexusPluginBridge } from '../services/ServiceAccessor';

/**
 * Service availability status
 */
export interface ServiceStatus {
  available: boolean;
  initialized: boolean;
  lastError?: string;
  lastCheck: number;
  retryCount: number;
}

/**
 * Service integration configuration
 */
export interface ServiceIntegrationConfig {
  maxRetries: number;
  retryDelayMs: number;
  timeoutMs: number;
  enableHealthCheck: boolean;
  fallbackBehavior: 'fail' | 'warn' | 'silent';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * Service access result with detailed error information
 */
export interface ServiceAccessResult<T> {
  success: boolean;
  service: T | null;
  error?: string;
  status: ServiceStatus;
  diagnostics?: ServiceAccessDiagnostics;
}

export interface ServiceAccessDiagnostics {
    pluginFound: boolean;
    serviceContainerAvailable: boolean;
    serviceFound: boolean;
    methodUsed: string;
    duration: number;
}

/**
 * Robust service integration utility for memory manager operations
 */
export class ServiceIntegration {
  private static readonly DEFAULT_CONFIG: ServiceIntegrationConfig = {
    maxRetries: 3,
    retryDelayMs: 500,
    timeoutMs: 5000,
    enableHealthCheck: true,
    fallbackBehavior: 'warn',
    logLevel: 'warn'
  };

  private app: App;
  private config: ServiceIntegrationConfig;
  private serviceStatuses: Map<string, ServiceStatus> = new Map();

  constructor(app: App, config: Partial<ServiceIntegrationConfig> = {}) {
    this.app = app;
    this.config = { ...ServiceIntegration.DEFAULT_CONFIG, ...config };
  }

  /**
   * Get memory service with robust error handling and retry logic
   */
  async getMemoryService(): Promise<ServiceAccessResult<MemoryService>> {
    return this.getService<MemoryService>('memoryService', 'MemoryService');
  }

  /**
   * Get workspace service with robust error handling and retry logic
   */
  async getWorkspaceService(): Promise<ServiceAccessResult<WorkspaceService>> {
    return this.getService<WorkspaceService>('workspaceService', 'WorkspaceService');
  }

  /**
   * Get memory service synchronously (for immediate availability checks)
   */
  getMemoryServiceSync(): ServiceAccessResult<MemoryService> {
    return this.getServiceSync<MemoryService>('memoryService', 'MemoryService');
  }

  /**
   * Get workspace service synchronously (for immediate availability checks)
   */
  getWorkspaceServiceSync(): ServiceAccessResult<WorkspaceService> {
    return this.getServiceSync<WorkspaceService>('workspaceService', 'WorkspaceService');
  }

  /**
   * Core service access method with comprehensive error handling
   */
  private async getService<T>(serviceName: string, displayName: string): Promise<ServiceAccessResult<T>> {
    const startTime = Date.now();
    const status = this.getServiceStatus(serviceName);
    
    // If service was recently checked and failed, return cached failure
    if (!status.available && (Date.now() - status.lastCheck) < this.config.retryDelayMs) {
      this.log('debug', `[ServiceIntegration] Using cached failure for ${displayName}`);
      return this.createResult<T>(false, null, status.lastError || 'Service unavailable', status, {
        pluginFound: false,
        serviceContainerAvailable: false,
        serviceFound: false,
        methodUsed: 'cached',
        duration: Date.now() - startTime
      });
    }

    let attempts = 0;
    let lastError = '';

    while (attempts <= this.config.maxRetries) {
      try {
        attempts++;
        this.log('debug', `[ServiceIntegration] Attempting to get ${displayName} (attempt ${attempts}/${this.config.maxRetries + 1})`);

        const plugin = getNexusPlugin<NexusPluginBridge>(this.app);
        if (!plugin) {
          const knownIds = getAllPluginIds().join(`' or '`);
          lastError = `Plugin '${knownIds}' not found`;
          this.log('error', `[ServiceIntegration] ${lastError}`);
          
          if (attempts <= this.config.maxRetries) {
            await this.delay(this.config.retryDelayMs);
            continue;
          }
          break;
        }

        const diagnostics = {
          pluginFound: true,
          serviceContainerAvailable: false,
          serviceFound: false,
          methodUsed: '',
          duration: 0
        };

        // Try ServiceContainer first (preferred method)
        if (plugin.serviceContainer) {
          this.log('debug', `[ServiceIntegration] Trying ServiceContainer for ${displayName}`);
          diagnostics.serviceContainerAvailable = true;
          diagnostics.methodUsed = 'serviceContainer';

          const service = plugin.serviceContainer.getIfReady<T>(serviceName);
          if (service) {
            this.log('debug', `[ServiceIntegration] Successfully got ${displayName} via ServiceContainer`);
            diagnostics.serviceFound = true;
            diagnostics.duration = Date.now() - startTime;
            
            const successStatus = this.updateServiceStatus(serviceName, true, undefined);
            return this.createResult<T>(true, service, undefined, successStatus, diagnostics);
          }
        }

        // Try async getService method
        if (plugin.getService) {
          this.log('debug', `[ServiceIntegration] Trying async getService for ${displayName}`);
          diagnostics.methodUsed = diagnostics.methodUsed ? `${diagnostics.methodUsed}+async` : 'async';

          try {
            const service = await this.withTimeout(plugin.getService<T>(serviceName), this.config.timeoutMs);
            if (service) {
              this.log('debug', `[ServiceIntegration] Successfully got ${displayName} via async method`);
              diagnostics.serviceFound = true;
              diagnostics.duration = Date.now() - startTime;
              
              const successStatus = this.updateServiceStatus(serviceName, true, undefined);
              return this.createResult<T>(true, service, undefined, successStatus, diagnostics);
            }
          } catch (asyncError) {
            this.log('warn', `[ServiceIntegration] Async service access failed for ${displayName}:`, asyncError);
            lastError = getErrorMessage(asyncError);
          }
        }

        // Try direct services access (fallback)
        if (plugin.services && plugin.services[serviceName]) {
          this.log('debug', `[ServiceIntegration] Trying direct services access for ${displayName}`);
          diagnostics.methodUsed = diagnostics.methodUsed ? `${diagnostics.methodUsed}+direct` : 'direct';

          const service = plugin.services[serviceName] as T;
          if (service) {
            this.log('debug', `[ServiceIntegration] Successfully got ${displayName} via direct access`);
            diagnostics.serviceFound = true;
            diagnostics.duration = Date.now() - startTime;
            
            const successStatus = this.updateServiceStatus(serviceName, true, undefined);
            return this.createResult<T>(true, service, undefined, successStatus, diagnostics);
          }
        }

        lastError = `${displayName} not available through any access method`;
        this.log('warn', `[ServiceIntegration] ${lastError} (attempt ${attempts})`);

        if (attempts <= this.config.maxRetries) {
          await this.delay(this.config.retryDelayMs);
        }

      } catch (error) {
        lastError = getErrorMessage(error);
        this.log('error', `[ServiceIntegration] Error accessing ${displayName} (attempt ${attempts}):`, error);
        
        if (attempts <= this.config.maxRetries) {
          await this.delay(this.config.retryDelayMs);
        }
      }
    }

    // All attempts failed
    const failureStatus = this.updateServiceStatus(serviceName, false, lastError);
    const diagnostics = {
      pluginFound: false,
      serviceContainerAvailable: false,
      serviceFound: false,
      methodUsed: 'failed',
      duration: Date.now() - startTime
    };

    this.handleServiceFailure(displayName, lastError, attempts);
    return this.createResult<T>(false, null, lastError, failureStatus, diagnostics);
  }

  /**
   * Synchronous service access for immediate availability checks
   */
  private getServiceSync<T>(serviceName: string, displayName: string): ServiceAccessResult<T> {
    const startTime = Date.now();
    
    try {
      const plugin = getNexusPlugin<NexusPluginBridge>(this.app);
      if (!plugin) {
        const knownIds = getAllPluginIds().join(`' or '`);
        const error = `Plugin '${knownIds}' not found`;
        const status = this.updateServiceStatus(serviceName, false, error);
        return this.createResult<T>(false, null, error, status, {
          pluginFound: false,
          serviceContainerAvailable: false,
          serviceFound: false,
          methodUsed: 'sync',
          duration: Date.now() - startTime
        });
      }

      const diagnostics = {
        pluginFound: true,
        serviceContainerAvailable: !!plugin.serviceContainer,
        serviceFound: false,
        methodUsed: 'sync',
        duration: 0
      };

      // Try ServiceContainer first
      if (plugin.serviceContainer) {
        const service = plugin.serviceContainer.getIfReady<T>(serviceName);
        if (service) {
          diagnostics.serviceFound = true;
          diagnostics.duration = Date.now() - startTime;
          const status = this.updateServiceStatus(serviceName, true, undefined);
          return this.createResult<T>(true, service, undefined, status, diagnostics);
        }
      }

      // Try direct access
      if (plugin.services && plugin.services[serviceName]) {
        const service = plugin.services[serviceName] as T;
        if (service) {
          diagnostics.serviceFound = true;
          diagnostics.methodUsed = 'direct';
          diagnostics.duration = Date.now() - startTime;
          const status = this.updateServiceStatus(serviceName, true, undefined);
          return this.createResult<T>(true, service, undefined, status, diagnostics);
        }
      }

      const error = `${displayName} not available synchronously`;
      const status = this.updateServiceStatus(serviceName, false, error);
      return this.createResult<T>(false, null, error, status, diagnostics);

    } catch (error) {
      const errorMessage = getErrorMessage(error);
      const status = this.updateServiceStatus(serviceName, false, errorMessage);
      return this.createResult<T>(false, null, errorMessage, status, {
        pluginFound: false,
        serviceContainerAvailable: false,
        serviceFound: false,
        methodUsed: 'sync-failed',
        duration: Date.now() - startTime
      });
    }
  }

  /**
   * Get or create service status tracking
   */
  private getServiceStatus(serviceName: string): ServiceStatus {
    if (!this.serviceStatuses.has(serviceName)) {
      this.serviceStatuses.set(serviceName, {
        available: false,
        initialized: false,
        lastCheck: 0,
        retryCount: 0
      });
    }
    const existingStatus = this.serviceStatuses.get(serviceName);
    if (existingStatus) {
      return existingStatus;
    }

    const status: ServiceStatus = {
      available: false,
      initialized: false,
      lastCheck: 0,
      retryCount: 0
    };
    this.serviceStatuses.set(serviceName, status);
    return status;
  }

  /**
   * Update service status tracking
   */
  private updateServiceStatus(serviceName: string, available: boolean, error?: string): ServiceStatus {
    const status = this.getServiceStatus(serviceName);
    
    status.available = available;
    status.initialized = available;
    status.lastError = error;
    status.lastCheck = Date.now();
    
    if (available) {
      status.retryCount = 0;
    } else {
      status.retryCount++;
    }

    this.serviceStatuses.set(serviceName, status);
    return status;
  }

  /**
   * Create standardized service access result
   */
  private createResult<T>(
    success: boolean,
    service: T | null,
    error?: string,
    status?: ServiceStatus,
    diagnostics?: ServiceAccessDiagnostics
  ): ServiceAccessResult<T> {
    return {
      success,
      service,
      error,
      status: status || {
        available: success,
        initialized: success,
        lastError: error,
        lastCheck: Date.now(),
        retryCount: 0
      },
      diagnostics
    };
  }

  /**
   * Handle service failure with appropriate logging and fallback behavior
   */
  private handleServiceFailure(serviceName: string, error: string, attempts: number): void {
    const message = `${serviceName} unavailable after ${attempts} attempts: ${error}`;
    
    switch (this.config.fallbackBehavior) {
      case 'fail':
        this.log('error', `[ServiceIntegration] CRITICAL: ${message}`);
        break;
      case 'warn':
        this.log('warn', `[ServiceIntegration] WARNING: ${message} - operations will be limited`);
        break;
      case 'silent':
        this.log('debug', `[ServiceIntegration] ${message}`);
        break;
    }
  }

  /**
   * Timeout wrapper for promises
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => 
        setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
      )
    ]);
  }

  /**
   * Delay utility for retry logic
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Configurable logging
   */
  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: unknown[]): void {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    const configLevel = levels[this.config.logLevel];
    const messageLevel = levels[level];
    
    if (messageLevel >= configLevel) {
      // eslint-disable-next-line no-console
      console[level](message, ...args);
    }
  }

  /**
   * Reset service status (for testing or manual intervention)
   */
  resetServiceStatus(serviceName?: string): void {
    if (serviceName) {
      this.serviceStatuses.delete(serviceName);
    } else {
      this.serviceStatuses.clear();
    }
  }

  /**
   * Get comprehensive service diagnostics
   */
  getDiagnostics(): Record<string, ServiceStatus> {
    const diagnostics: Record<string, ServiceStatus> = {};
    
    for (const [serviceName, status] of this.serviceStatuses.entries()) {
      diagnostics[serviceName] = { ...status };
    }
    
    return diagnostics;
  }
}

/**
 * Default service integration instance factory
 * Creates a standard service integration with recommended settings
 */
export function createServiceIntegration(app: App, config?: Partial<ServiceIntegrationConfig>): ServiceIntegration {
  return new ServiceIntegration(app, {
    maxRetries: 2,
    retryDelayMs: 300,
    timeoutMs: 3000,
    enableHealthCheck: true,
    fallbackBehavior: 'warn',
    logLevel: 'warn',
    ...config
  });
}
