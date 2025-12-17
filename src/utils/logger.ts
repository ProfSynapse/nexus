/**
 * Enhanced logger that handles different types of logging.
 * Used to replace all console.log/warn/error calls with a centralized system
 * that can be configured to show only necessary logs.
 */
export const logger = {
    /**
     * Log fatal system errors that prevent core functionality
     */
    systemError(error: Error, context?: string) {
        console.error(
            `SYSTEM ERROR${context ? ` [${context}]` : ''}: ${error.message}`
        );
    },
    
    /**
     * Log system warnings that don't prevent functionality but indicate issues
     */
    systemWarn(message: string, context?: string) {
        // No-op
    },
    
    /**
     * Log informational messages during development
     */
    systemLog(message: string, context?: string) {
        // No-op
    }
    
    // operationError function removed to eliminate unnecessary console logs
};
