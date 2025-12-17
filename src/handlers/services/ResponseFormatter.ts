import { IResponseFormatter } from '../interfaces/IRequestHandlerServices';
import { safeStringify } from '../../utils/jsonUtils';

export class ResponseFormatter implements IResponseFormatter {

    formatToolExecutionResponse(result: any, sessionInfo?: any, _context?: { tool?: string }): any {
        // Check if result contains an error and format it appropriately
        if (result && !result.success && result.error) {
            return this.formatDetailedError(result, sessionInfo);
        }

        // CRITICAL: Always show session ID changes/creation, regardless of shouldInjectInstructions
        // This ensures Claude Desktop always knows when its session ID was replaced or assigned
        if (sessionInfo && (sessionInfo.isNonStandardId || sessionInfo.isNewSession)) {
            return this.formatWithSessionInstructions(result, sessionInfo);
        }

        return {
            content: [{
                type: "text",
                text: safeStringify(result)
            }]
        };
    }

    formatSessionInstructions(sessionId: string, result: any): any {
        result.sessionId = sessionId;
        return result;
    }

    formatErrorResponse(error: Error): any {
        return {
            content: [{
                type: "text",
                text: `Error: ${error.message}`
            }]
        };
    }

    /**
     * Format detailed error with helpful context
     * Shows the actual error message and any additional context that can help the AI fix the issue
     */
    private formatDetailedError(result: any, sessionInfo?: any): any {
        let errorText = "";
        
        // CRITICAL: Show session ID changes EVEN IN ERROR RESPONSES
        // This ensures Claude knows the correct session ID even when operations fail
        if (sessionInfo && (sessionInfo.isNonStandardId || sessionInfo.isNewSession)) {
            if (sessionInfo.isNonStandardId && sessionInfo.originalSessionId) {
                errorText += `⚠️ SESSION ID CHANGED ⚠️\n`;
                errorText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
                errorText += `Your session ID "${sessionInfo.originalSessionId}" was replaced.\n`;
                errorText += `NEW SESSION ID: ${sessionInfo.sessionId}\n`;
                errorText += `\n`;
                errorText += `🔴 MANDATORY: Use "${sessionInfo.sessionId}" in ALL future requests!\n`;
                errorText += `🔴 DO NOT use "${sessionInfo.originalSessionId}" anymore!\n`;
                errorText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
            } else if (sessionInfo.isNewSession) {
                errorText += `🆕 NEW SESSION CREATED\n`;
                errorText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
                errorText += `SESSION ID: ${sessionInfo.sessionId}\n`;
                errorText += `\n`;
                errorText += `🔴 MANDATORY: Use this ID in all future requests!\n`;
                errorText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
            }
        }
        
        errorText += `❌ Error: ${result.error}\n\n`;
        
        // Add parameter-specific hints if available
        if (result.parameterHints) {
            errorText += `💡 Parameter Help:\n${result.parameterHints}\n\n`;
        }
        
        // Add what was provided vs what was expected
        if (result.providedParams) {
            errorText += `📋 Provided Parameters:\n${safeStringify(result.providedParams)}\n\n`;
        }
        
        if (result.expectedParams) {
            errorText += `✅ Expected Parameters:\n${safeStringify(result.expectedParams)}\n\n`;
        }
        
        // Add suggestions for common mistakes
        if (result.suggestions) {
            errorText += `💭 Suggestions:\n`;
            for (const suggestion of result.suggestions) {
                errorText += `  • ${suggestion}\n`;
            }
            errorText += '\n';
        }
        
        // Include the full result object for debugging
        errorText += `🔍 Full Error Details:\n${safeStringify(result)}`;
        
        return {
            content: [{
                type: "text",
                text: errorText
            }]
        };
    }

    private formatWithSessionInstructions(result: any, sessionInfo: any): any {
        this.formatSessionInstructions(sessionInfo.sessionId, result);

        let responseText = "";

        // CRITICAL: Make session ID changes extremely prominent
        if (sessionInfo.isNonStandardId && sessionInfo.originalSessionId) {
            responseText += `⚠️ SESSION ID CHANGED ⚠️\n`;
            responseText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
            responseText += `Your session ID "${sessionInfo.originalSessionId}" was replaced.\n`;
            responseText += `NEW SESSION ID: ${sessionInfo.sessionId}\n`;
            responseText += `\n`;
            responseText += `🔴 MANDATORY: Use "${sessionInfo.sessionId}" in ALL future requests!\n`;
            responseText += `🔴 DO NOT use "${sessionInfo.originalSessionId}" anymore!\n`;
            responseText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        } else if (sessionInfo.isNewSession) {
            responseText += `🆕 NEW SESSION CREATED\n`;
            responseText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
            responseText += `SESSION ID: ${sessionInfo.sessionId}\n`;
            responseText += `\n`;
            responseText += `🔴 MANDATORY: Use this ID in all future requests!\n`;
            responseText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        }

        responseText += safeStringify(result);

        return {
            content: [{
                type: "text",
                text: responseText
            }]
        };
    }
}