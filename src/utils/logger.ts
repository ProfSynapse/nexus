/**
 * Enhanced logger that handles different types of logging.
 * Used to replace all console.log/warn/error calls with a centralized system
 * that can be configured to show only necessary logs.
 */
export const logger = {
    /**
     * Log fatal system errors that prevent core functionality
     */
    systemError(error: Error, context?: string): void {
        console.error(
            `SYSTEM ERROR${context ? ` [${context}]` : ''}: ${error.message}`
        );
    },
    
    /**
     * Log system warnings that don't prevent functionality but indicate issues
     */
    systemWarn(_message: string, _context?: string): void {
        // No-op
    },
    
    /**
     * Log informational messages during development
     */
    systemLog(_message: string, _context?: string): void {
        // No-op
    }
    
    // operationError function removed to eliminate unnecessary console logs
};
