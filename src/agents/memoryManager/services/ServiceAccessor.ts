/**
 * Location: /src/agents/memoryManager/services/ServiceAccessor.ts
 *
 * Purpose: Core service access logic with retry and error handling
 * Extracted from ValidationService.ts to separate concerns
 *
 * Used by: ValidationService for service discovery and access
 * Dependencies: App (Obsidian)
 */

import { App, Plugin } from 'obsidian';
import { getErrorMessage } from '../../../utils/errorUtils';
import { getAllPluginIds } from '../../../constants/branding';
import { getNexusPlugin } from '../../../utils/pluginLocator';

export interface ServiceStatus {
  available: boolean;
  initialized: boolean;
  lastError?: string;
  lastCheck: number;
  retryCount: number;
}

export interface ServiceAccessResult<T> {
  success: boolean;
  service: T | null;
  error?: string;
  status: ServiceStatus;
  diagnostics?: {
    pluginFound: boolean;
    serviceContainerAvailable: boolean;
    serviceFound: boolean;
    methodUsed: string;
    duration: number;
  };
}

export interface ServiceIntegrationConfig {
  maxRetries: number;
  retryDelayMs: number;
  timeoutMs: number;
  enableHealthCheck: boolean;
  fallbackBehavior: 'fail' | 'warn' | 'silent';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface NexusPluginBridge extends Plugin {
  services?: Record<string, unknown>;
  serviceContainer?: {
    getIfReady<T>(serviceName: string): T | null;
  };
  getService?<T>(serviceName: string): Promise<T>;
}

/**
 * Handles service access with robust error handling and retry logic
 */
export class ServiceAccessor {
  private serviceStatuses: Map<string, ServiceStatus> = new Map();

  constructor(
    private app: App,
    private config: ServiceIntegrationConfig
  ) {}

  /**
   * Get service with comprehensive error handling
   */
  async getService<T>(serviceName: string, displayName: string): Promise<ServiceAccessResult<T>> {
    const startTime = Date.now();
    const status = this.getServiceStatus(serviceName);

    // If service was recently checked and failed, return cached failure
    if (!status.available && (Date.now() - status.lastCheck) < this.config.retryDelayMs) {
      this.log('debug', `[ServiceAccessor] Using cached failure for ${displayName}`);
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
        this.log('debug', `[ServiceAccessor] Attempting to get ${displayName} (attempt ${attempts}/${this.config.maxRetries + 1})`);

        const plugin = getNexusPlugin<NexusPluginBridge>(this.app);
        if (!plugin) {
          const knownIds = getAllPluginIds().join(`' or '`);
          lastError = `Plugin '${knownIds}' not found`;
          this.log('error', `[ServiceAccessor] ${lastError}`);

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
          this.log('debug', `[ServiceAccessor] Trying ServiceContainer for ${displayName}`);
          diagnostics.serviceContainerAvailable = true;
          diagnostics.methodUsed = 'serviceContainer';

          const service = plugin.serviceContainer.getIfReady<T>(serviceName);
          if (service) {
            this.log('debug', `[ServiceAccessor] Successfully got ${displayName} via ServiceContainer`);
            diagnostics.serviceFound = true;
            diagnostics.duration = Date.now() - startTime;

            const successStatus = this.updateServiceStatus(serviceName, true, undefined);
            return this.createResult<T>(true, service, undefined, successStatus, diagnostics);
          }
        }

        // Try async getService method
        if (plugin.getService) {
          this.log('debug', `[ServiceAccessor] Trying async getService for ${displayName}`);
          diagnostics.methodUsed = diagnostics.methodUsed ? `${diagnostics.methodUsed}+async` : 'async';

          try {
            const service = await this.withTimeout(plugin.getService<T>(serviceName), this.config.timeoutMs);
            if (service) {
              this.log('debug', `[ServiceAccessor] Successfully got ${displayName} via async method`);
              diagnostics.serviceFound = true;
              diagnostics.duration = Date.now() - startTime;

              const successStatus = this.updateServiceStatus(serviceName, true, undefined);
              return this.createResult<T>(true, service, undefined, successStatus, diagnostics);
            }
          } catch (asyncError) {
            this.log('warn', `[ServiceAccessor] Async service access failed for ${displayName}:`, asyncError);
            lastError = getErrorMessage(asyncError);
          }
        }

        // Try direct services access (fallback)
        if (plugin.services && plugin.services[serviceName]) {
          this.log('debug', `[ServiceAccessor] Trying direct services access for ${displayName}`);
          diagnostics.methodUsed = diagnostics.methodUsed ? `${diagnostics.methodUsed}+direct` : 'direct';

          const service = plugin.services[serviceName] as T;
          if (service) {
            this.log('debug', `[ServiceAccessor] Successfully got ${displayName} via direct access`);
            diagnostics.serviceFound = true;
            diagnostics.duration = Date.now() - startTime;

            const successStatus = this.updateServiceStatus(serviceName, true, undefined);
            return this.createResult<T>(true, service, undefined, successStatus, diagnostics);
          }
        }

        lastError = `${displayName} not available through any access method`;
        this.log('warn', `[ServiceAccessor] ${lastError} (attempt ${attempts})`);

        if (attempts <= this.config.maxRetries) {
          await this.delay(this.config.retryDelayMs);
        }

      } catch (error) {
        lastError = getErrorMessage(error);
        this.log('error', `[ServiceAccessor] Error accessing ${displayName} (attempt ${attempts}):`, error);

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
   * Get service synchronously for immediate availability checks
   */
  getServiceSync<T>(serviceName: string, displayName: string): ServiceAccessResult<T> {
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
    return this.serviceStatuses.get(serviceName)!;
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
    diagnostics?: any
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
   * Handle service failure with appropriate logging
   */
  private handleServiceFailure(serviceName: string, error: string, attempts: number): void {
    const message = `${serviceName} unavailable after ${attempts} attempts: ${error}`;

    switch (this.config.fallbackBehavior) {
      case 'fail':
        this.log('error', `[ServiceAccessor] CRITICAL: ${message}`);
        break;
      case 'warn':
        this.log('warn', `[ServiceAccessor] WARNING: ${message} - operations will be limited`);
        break;
      case 'silent':
        this.log('debug', `[ServiceAccessor] ${message}`);
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
  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: any[]): void {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    const configLevel = levels[this.config.logLevel];
    const messageLevel = levels[level];

    if (messageLevel >= configLevel) {
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
