import { IResponseFormatter, ToolExecutionResult, SessionInfo, MCPContentResponse } from '../interfaces/IRequestHandlerServices';
import { safeStringify } from '../../utils/jsonUtils';

export class ResponseFormatter implements IResponseFormatter {

    formatToolExecutionResponse(result: ToolExecutionResult, sessionInfo?: SessionInfo, _context?: { tool?: string }): MCPContentResponse {
        // Check if result contains an error and format it appropriately
        if (result && !result.success && result.error) {
            return this.formatDetailedError(result, sessionInfo);
        }

        // Only show session ID message when Claude's ID was REPLACED (non-standard format)
        // If Claude provided a valid format ID, no need to announce - just use it silently
        if (sessionInfo && sessionInfo.isNonStandardId) {
            return this.formatWithSessionInstructions(result, sessionInfo);
        }

        return {
            content: [{
                type: "text",
                text: safeStringify(result)
            }]
        };
    }

    formatSessionInstructions(sessionId: string, result: ToolExecutionResult): ToolExecutionResult {
        (result as ToolExecutionResult & { sessionId: string }).sessionId = sessionId;
        return result;
    }

    formatErrorResponse(error: Error): MCPContentResponse {
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
    private formatDetailedError(result: ToolExecutionResult, sessionInfo?: SessionInfo): MCPContentResponse {
        let errorText = "";
        
        // Compact session ID notice when replaced
        if (sessionInfo?.isNonStandardId && sessionInfo.originalSessionId) {
            errorText += `[Session ID changed: Use "${sessionInfo.sessionId}" for all future requests]\n\n`;
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
        if (result.suggestions && Array.isArray(result.suggestions)) {
            errorText += `💭 Suggestions:\n`;
            for (const suggestion of result.suggestions as unknown[]) {
                errorText += `  • ${String(suggestion)}\n`;
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

    private formatWithSessionInstructions(result: ToolExecutionResult, sessionInfo: SessionInfo): MCPContentResponse {
        this.formatSessionInstructions(sessionInfo.sessionId, result);

        let responseText = "";

        // Compact session ID notice when replaced
        if (sessionInfo.originalSessionId) {
            responseText += `[Session ID changed: Use "${sessionInfo.sessionId}" for all future requests]\n\n`;
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