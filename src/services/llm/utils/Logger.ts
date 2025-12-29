/**
 * Enhanced Logger
 * Structured logging with multiple outputs and severity levels
 * Based on patterns from existing logging services
 *
 * MOBILE COMPATIBILITY (Dec 2025):
 * - Removed Node.js fs and path imports
 * - File logging only works via Obsidian vault adapter
 * - Falls back to console-only logging if vault adapter not configured
 */

import { normalizePath } from 'obsidian';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  message: string;
  component?: string;
  metadata?: Record<string, unknown>;
  executionId?: string;
  testId?: string;
}

export interface LoggerConfig {
  level: LogLevel;
  enableConsole: boolean;
  enableFile: boolean;
  logDirectory: string;
  maxFileSize: number; // in bytes
  maxFiles: number;
  includeTimestamp: boolean;
  includeStackTrace: boolean;
}

export class Logger {
  private static instance: Logger;
  private config: LoggerConfig;
  private static vaultAdapterConfig: { adapter: any; baseDir: string } | null = null;
  private logLevels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
  };

  private constructor(config?: Partial<LoggerConfig>) {
    this.config = {
      level: 'info',
      enableConsole: true,
      enableFile: false,
      logDirectory: './logs',
      maxFileSize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      includeTimestamp: true,
      includeStackTrace: false,
      ...config
    };

    this.ensureLogDirectory();
  }

  /**
   * Get singleton instance
   */
  static getInstance(config?: Partial<LoggerConfig>): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger(config);
    }
    return Logger.instance;
  }

  /**
   * Create a child logger with component context
   */
  child(component: string): ComponentLogger {
    return new ComponentLogger(this, component);
  }

  /**
   * Debug level logging
   */
  debug(message: string, metadata?: Record<string, unknown>): void {
    this.log('debug', message, metadata);
  }

  /**
   * Info level logging
   */
  info(message: string, metadata?: Record<string, unknown>): void {
    this.log('info', message, metadata);
  }

  /**
   * Warning level logging
   */
  warn(message: string, metadata?: Record<string, unknown>): void {
    this.log('warn', message, metadata);
  }

  /**
   * Error level logging
   */
  error(message: string, error?: Error | Record<string, unknown>): void {
    const metadata = error instanceof Error ? {
      error: error.message,
      stack: error.stack
    } : error;
    
    this.log('error', message, metadata);
  }

  /**
   * Log test execution events
   */
  testEvent(event: string, testId: string, metadata?: Record<string, unknown>): void {
    this.log('info', `Test Event: ${event}`, {
      testId,
      eventType: 'test',
      ...metadata
    });
  }

  /**
   * Log optimization events
   */
  optimizationEvent(event: string, generation: number, metadata?: Record<string, unknown>): void {
    this.log('info', `Optimization: ${event}`, {
      generation,
      eventType: 'optimization',
      ...metadata
    });
  }

  /**
   * Log provider API calls
   */
  apiCall(provider: string, method: string, latency: number, tokens?: number, cost?: number): void {
    this.log('debug', `API Call: ${provider}.${method}`, {
      provider,
      method,
      latency,
      tokens,
      cost,
      eventType: 'api'
    });
  }

  /**
   * Log performance metrics
   */
  performance(operation: string, duration: number, metadata?: Record<string, unknown>): void {
    this.log('info', `Performance: ${operation}`, {
      operation,
      duration,
      eventType: 'performance',
      ...metadata
    });
  }

  /**
   * Main logging method
   */
  log(level: LogLevel, message: string, metadata?: Record<string, unknown>, component?: string): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      message
    };
    
    if (component !== undefined) entry.component = component;
    if (metadata !== undefined) entry.metadata = metadata;

    if (this.config.enableConsole) {
      this.logToConsole(entry);
    }

    if (this.config.enableFile) {
      this.logToFile(entry);
    }
  }

  /**
   * Update logger configuration
   */
  configure(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
    this.ensureLogDirectory();
  }

  /**
   * Get current log level
   */
  getLevel(): LogLevel {
    return this.config.level;
  }

  /**
   * Set log level
   */
  setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  /**
   * Enable file logging
   */
  enableFileLogging(directory?: string): void {
    this.config.enableFile = true;
    if (directory) {
      this.config.logDirectory = directory;
    }
    this.ensureLogDirectory();
  }

  /**
   * Disable file logging
   */
  disableFileLogging(): void {
    this.config.enableFile = false;
  }

  /**
   * Flush logs (useful for testing)
   */
  flush(): void {
    // In a real implementation, this would flush any buffered logs
  }

  // Private methods

  private shouldLog(level: LogLevel): boolean {
    return this.logLevels[level] >= this.logLevels[this.config.level];
  }

  private logToConsole(entry: LogEntry): void {
    const timestamp = this.config.includeTimestamp 
      ? `[${entry.timestamp.toISOString()}] `
      : '';
    
    const component = entry.component ? `[${entry.component}] ` : '';
    const level = `[${entry.level.toUpperCase()}] `;
    
    let output = `${timestamp}${level}${component}${entry.message}`;
    
    if (entry.metadata && Object.keys(entry.metadata).length > 0) {
      output += ` ${JSON.stringify(entry.metadata, null, 2)}`;
    }

    switch (entry.level) {
      case 'error':
        console.error(output);
        break;
    }
  }

  private logToFile(entry: LogEntry): void {
    if (!Logger.vaultAdapterConfig) {
      return;
    }

    const logFile = normalizePath(`${this.config.logDirectory}/lab-kit-${this.getDateString()}.log`);
    const line = JSON.stringify(entry) + '\n';
    this.writeViaVaultAdapter(logFile, line);
  }

  private ensureLogDirectory(): void {
    if (!this.config.enableFile) return;

    // File logging only works with vault adapter (mobile compatible)
    if (Logger.vaultAdapterConfig) {
      const dir = normalizePath(Logger.vaultAdapterConfig.baseDir || '.nexus/logs');
      Logger.vaultAdapterConfig.adapter.mkdir(dir).catch(() => {});
      this.config.logDirectory = dir;
    } else {
      // No vault adapter - disable file logging on mobile
      this.config.enableFile = false;
    }
  }

  private getDateString(): string {
    return new Date().toISOString().split('T')[0]!;
  }

  // Log rotation not supported on mobile - rely on manual cleanup or vault sync
  // These methods are kept as stubs for API compatibility
  private rotateLogsIfNeeded(_logFile: string): void {
    // Not supported with vault adapter approach - logs managed via vault sync
  }

  private cleanupOldLogs(): void {
    // Not supported with vault adapter approach - logs managed via vault sync
  }

  /**
   * Configure vault adapter-backed logging (uses Obsidian vault adapter for writes).
   */
  static setVaultAdapter(adapter: any, baseDir: string = '.nexus/logs') {
    Logger.vaultAdapterConfig = { adapter, baseDir };
    if (Logger.instance) {
      Logger.instance.config.logDirectory = baseDir;
      Logger.instance.ensureLogDirectory();
    }
  }

  private writeViaVaultAdapter(logFile: string, line: string) {
    const adapter = Logger.vaultAdapterConfig?.adapter;
    if (!adapter) return;
    const normalizedPath = normalizePath(logFile);
    adapter.read(normalizedPath)
      .catch(() => '')
      .then((existing: string) => adapter.write(normalizedPath, `${existing}${line}`))
      .catch((error: Error) => {
        console.error('Failed to write to vault-backed log file:', error);
      });
  }
}

/**
 * Component-specific logger that includes component context
 */
export class ComponentLogger {
  constructor(
    private parent: Logger,
    private component: string
  ) {}

  debug(message: string, metadata?: Record<string, unknown>): void {
    this.parent.log('debug', message, metadata, this.component);
  }

  info(message: string, metadata?: Record<string, unknown>): void {
    this.parent.log('info', message, metadata, this.component);
  }

  warn(message: string, metadata?: Record<string, unknown>): void {
    this.parent.log('warn', message, metadata, this.component);
  }

  error(message: string, error?: Error | Record<string, unknown>): void {
    const metadata = error instanceof Error ? {
      error: error.message,
      stack: error.stack
    } : error;
    
    this.parent.log('error', message, metadata, this.component);
  }

  testEvent(event: string, testId: string, metadata?: Record<string, unknown>): void {
    this.parent.testEvent(event, testId, { component: this.component, ...metadata });
  }

  apiCall(provider: string, method: string, latency: number, tokens?: number, cost?: number): void {
    this.parent.apiCall(provider, method, latency, tokens, cost);
  }

  performance(operation: string, duration: number, metadata?: Record<string, unknown>): void {
    this.parent.performance(operation, duration, { component: this.component, ...metadata });
  }
}

/**
 * Global logger instance
 */
export const logger = Logger.getInstance();

/**
 * Create a logger for a specific component
 */
export function createLogger(component: string): ComponentLogger {
  return logger.child(component);
}
