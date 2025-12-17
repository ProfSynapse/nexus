/**
 * StructuredLogger - Structured logging system replacing console.log proliferation
 * Location: src/core/StructuredLogger.ts
 * 
 * This service replaces the 1,286+ console.log statements throughout the codebase
 * with a proper logging system that respects debug modes, provides structured output,
 * and includes log management features.
 * 
 * Key features:
 * - Configurable log levels and debug mode
 * - Structured log entries with metadata
 * - Context-specific loggers for modules
 * - Log buffering and export functionality
 * - Performance timing utilities
 * - Cross-platform compatibility
 * 
 * Used by:
 * - All services to replace console.log statements
 * - Debug and troubleshooting operations
 * - Performance monitoring
 * - Error tracking and reporting
 */

import { Platform, Plugin } from 'obsidian';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

/**
 * Extended Performance interface for Chrome's memory API
 * Chrome-specific extension not available in all browsers
 */
interface PerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

interface PerformanceWithMemory extends Performance {
  memory: PerformanceMemory;
}

/**
 * Type guard to check if performance.memory is available
 * This is a Chrome-specific feature not available in all environments
 */
function hasMemoryAPI(perf: Performance): perf is PerformanceWithMemory {
  return 'memory' in perf &&
         perf.memory !== undefined &&
         perf.memory !== null &&
         typeof perf.memory === 'object' &&
         'usedJSHeapSize' in perf.memory;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: any;
  context?: string;
  plugin: string;
  performance?: {
    duration?: number;
    memory?: number;
  };
}

export interface LoggerConfig {
  debugMode: boolean;
  level: LogLevel;
  maxBufferSize: number;
  enablePerformanceLogging: boolean;
  enableExport: boolean;
}

/**
 * Context-specific logger for modules/services
 */
export class ContextLogger {
  constructor(
    private logger: StructuredLogger,
    private context: string
  ) {}

  debug(message: string, data?: any): void {
    this.logger.debug(message, data, this.context);
  }

  info(message: string, data?: any): void {
    this.logger.info(message, data, this.context);
  }

  warn(message: string, data?: any): void {
    this.logger.warn(message, data, this.context);
  }

  error(message: string, error?: Error): void {
    this.logger.error(message, error, this.context);
  }

  time(label: string): void {
    this.logger.time(`${this.context}:${label}`);
  }

  timeEnd(label: string): void {
    this.logger.timeEnd(`${this.context}:${label}`);
  }
}

/**
 * Structured logging system replacing console.log proliferation
 * Configurable levels and proper error handling
 */
export class StructuredLogger {
  private config: LoggerConfig;
  private logBuffer: LogEntry[] = [];
  private timers = new Map<string, number>();
  private contextLoggers = new Map<string, ContextLogger>();

  constructor(private plugin: Plugin) {
    this.config = {
      debugMode: false,
      level: LogLevel.INFO,
      maxBufferSize: 1000,
      enablePerformanceLogging: false,
      enableExport: true
    };
    
    this.loadLogSettings();
  }

  private async loadLogSettings(): Promise<void> {
    try {
      const settings = await this.plugin.loadData();
      const loggingSettings = settings?.logging;

      if (loggingSettings) {
        this.config = {
          debugMode: loggingSettings.debugMode || false,
          level: loggingSettings.level || LogLevel.INFO,
          maxBufferSize: loggingSettings.maxBufferSize || 1000,
          enablePerformanceLogging: loggingSettings.enablePerformanceLogging || false,
          enableExport: loggingSettings.enableExport !== false
        };
      }
    } catch (error) {
    }
  }

  /**
   * Update logging configuration
   */
  async updateConfig(newConfig: Partial<LoggerConfig>): Promise<void> {
    this.config = { ...this.config, ...newConfig };
    
    try {
      const settings = await this.plugin.loadData() || {};
      settings.logging = this.config;
      await this.plugin.saveData(settings);
    } catch (error) {
      console.error('[StructuredLogger] Failed to save log configuration:', error);
    }
  }

  /**
   * Debug level logging
   */
  debug(message: string, data?: any, context?: string): void {
    if (this.config.debugMode && this.shouldLog(LogLevel.DEBUG)) {
      this.log(LogLevel.DEBUG, message, data, context);
    }
  }

  /**
   * Info level logging
   */
  info(message: string, data?: any, context?: string): void {
    if (this.shouldLog(LogLevel.INFO)) {
      this.log(LogLevel.INFO, message, data, context);
    }
  }

  /**
   * Warning level logging
   */
  warn(message: string, data?: any, context?: string): void {
    if (this.shouldLog(LogLevel.WARN)) {
      this.log(LogLevel.WARN, message, data, context);
    }
  }

  /**
   * Error level logging
   */
  error(message: string, error?: Error, context?: string): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      // Extract error information
      const errorData = error ? {
        name: error.name,
        message: error.message,
        stack: error.stack
      } : undefined;
      
      this.log(LogLevel.ERROR, message, errorData, context);
    }
  }

  /**
   * Performance timing start
   */
  time(label: string): void {
    if (this.config.enablePerformanceLogging || this.config.debugMode) {
      this.timers.set(label, performance.now());
    }
  }

  /**
   * Performance timing end
   */
  timeEnd(label: string): void {
    if (this.config.enablePerformanceLogging || this.config.debugMode) {
      const startTime = this.timers.get(label);
      if (startTime !== undefined) {
        const duration = performance.now() - startTime;
        this.timers.delete(label);
        
        this.debug(`Performance: ${label} completed`, {
          duration: `${duration.toFixed(2)}ms`,
          label
        }, 'Performance');
      }
    }
  }

  /**
   * Create context-specific logger
   */
  createContextLogger(context: string): ContextLogger {
    if (!this.contextLoggers.has(context)) {
      this.contextLoggers.set(context, new ContextLogger(this, context));
    }
    return this.contextLoggers.get(context)!;
  }

  /**
   * Log performance metrics
   */
  logPerformance(operation: string, duration: number, context?: string): void {
    if (this.config.enablePerformanceLogging) {
      this.info(`Performance: ${operation}`, {
        duration: `${duration.toFixed(2)}ms`,
        operation
      }, context || 'Performance');
    }
  }

  /**
   * Log memory usage
   */
  logMemoryUsage(context?: string): void {
    if (this.config.enablePerformanceLogging && hasMemoryAPI(performance)) {
      const memInfo = performance.memory;
      this.debug('Memory usage', {
        used: `${(memInfo.usedJSHeapSize / 1024 / 1024).toFixed(2)} MB`,
        total: `${(memInfo.totalJSHeapSize / 1024 / 1024).toFixed(2)} MB`,
        limit: `${(memInfo.jsHeapSizeLimit / 1024 / 1024).toFixed(2)} MB`
      }, context || 'Memory');
    }
  }

  private log(level: LogLevel, message: string, data?: any, context?: string): void {
    const timestamp = new Date().toISOString();
    const logEntry: LogEntry = {
      timestamp,
      level,
      message,
      data,
      context,
      plugin: this.plugin.manifest.id
    };

    if (this.config.enablePerformanceLogging && hasMemoryAPI(performance)) {
      const memInfo = performance.memory;
      logEntry.performance = {
        memory: memInfo.usedJSHeapSize
      };
    }

    this.addToBuffer(logEntry);

    const formattedMessage = this.formatMessage(logEntry);

    if (level === LogLevel.ERROR) {
      console.error(formattedMessage, data || '');
    }
  }

  /**
   * Check if should log at level
   */
  private shouldLog(level: LogLevel): boolean {
    return level >= this.config.level;
  }

  /**
   * Format log message for console output
   */
  private formatMessage(entry: LogEntry): string {
    const levelStr = LogLevel[entry.level];
    const contextStr = entry.context ? ` [${entry.context}]` : '';
    const timestamp = new Date(entry.timestamp).toLocaleTimeString();
    
    return `[${entry.plugin}]${contextStr} ${levelStr}: ${entry.message} (${timestamp})`;
  }

  /**
   * Add entry to buffer with size management
   */
  private addToBuffer(entry: LogEntry): void {
    this.logBuffer.push(entry);
    
    if (this.logBuffer.length > this.config.maxBufferSize) {
      // Remove oldest entries
      const excess = this.logBuffer.length - this.config.maxBufferSize;
      this.logBuffer.splice(0, excess);
    }
  }

  /**
   * Export logs for debugging
   */
  async exportLogs(): Promise<string> {
    if (!this.config.enableExport) {
      throw new Error('Log export is disabled');
    }

    const exportData = {
      plugin: this.plugin.manifest.id,
      version: this.plugin.manifest.version,
      exported: new Date().toISOString(),
      config: this.config,
      platform: Platform.isMobile ? 'mobile' : 'desktop',
      logCount: this.logBuffer.length,
      logs: this.logBuffer
    };
    
    return JSON.stringify(exportData, null, 2);
  }

  /**
   * Get log statistics
   */
  getLogStats(): {
    totalEntries: number;
    byLevel: Record<string, number>;
    byContext: Record<string, number>;
    bufferSize: number;
    oldestEntry?: string;
    newestEntry?: string;
  } {
    const byLevel: Record<string, number> = {};
    const byContext: Record<string, number> = {};

    for (const entry of this.logBuffer) {
      const levelStr = LogLevel[entry.level];
      byLevel[levelStr] = (byLevel[levelStr] || 0) + 1;
      
      const context = entry.context || 'Unknown';
      byContext[context] = (byContext[context] || 0) + 1;
    }

    return {
      totalEntries: this.logBuffer.length,
      byLevel,
      byContext,
      bufferSize: this.config.maxBufferSize,
      oldestEntry: this.logBuffer[0]?.timestamp,
      newestEntry: this.logBuffer[this.logBuffer.length - 1]?.timestamp
    };
  }

  clearBuffer(): void {
    const clearedCount = this.logBuffer.length;
    this.logBuffer = [];
    this.info(`Log buffer cleared (${clearedCount} entries removed)`, undefined, 'Logger');
  }

  /**
   * Search logs by criteria
   */
  searchLogs(criteria: {
    level?: LogLevel;
    context?: string;
    message?: string;
    since?: Date;
    until?: Date;
  }): LogEntry[] {
    return this.logBuffer.filter(entry => {
      if (criteria.level !== undefined && entry.level !== criteria.level) {
        return false;
      }
      
      if (criteria.context && entry.context !== criteria.context) {
        return false;
      }
      
      if (criteria.message && !entry.message.toLowerCase().includes(criteria.message.toLowerCase())) {
        return false;
      }
      
      const entryTime = new Date(entry.timestamp);
      if (criteria.since && entryTime < criteria.since) {
        return false;
      }
      
      if (criteria.until && entryTime > criteria.until) {
        return false;
      }
      
      return true;
    });
  }

  /**
   * Enable or disable debug mode
   */
  async setDebugMode(enabled: boolean): Promise<void> {
    await this.updateConfig({ debugMode: enabled });
    this.info(`Debug mode ${enabled ? 'enabled' : 'disabled'}`, undefined, 'Logger');
  }

  /**
   * Set log level
   */
  async setLogLevel(level: LogLevel): Promise<void> {
    await this.updateConfig({ level });
    this.info(`Log level set to ${LogLevel[level]}`, undefined, 'Logger');
  }

  /**
   * Get current configuration
   */
  getConfig(): Readonly<LoggerConfig> {
    return { ...this.config };
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    // Clear all timers
    this.timers.clear();
    
    // Clear context loggers
    this.contextLoggers.clear();
    
    // Optionally preserve buffer for post-cleanup analysis
    if (this.config.debugMode) {
      this.info('StructuredLogger cleanup completed', {
        bufferedEntries: this.logBuffer.length
      }, 'Logger');
    }
  }
}