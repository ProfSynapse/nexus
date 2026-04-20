/**
 * Session utility functions for consistent session management
 * Provides standardized methods for generating and working with session IDs
 */

/**
 * Generate a standardized session ID based on current datetime
 * @returns Session ID in the format s-YYYYMMDDhhmmss
 */
export function generateSessionId(): string {
    const now = new Date();
    const formattedDate = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    return `s-${formattedDate}`;
}

/**
 * Format session instructions for Claude
 * @param sessionId The session ID to include in instructions
 * @returns Formatted instruction string
 */
export function formatSessionInstructions(sessionId: string): string {
    return `🔄 SESSION ID: ${sessionId} - MANDATORY: Use this ID in all future requests, do NOT use the name.`;
}

/**
 * Determines if a session ID is new (created by us) or externally provided
 * This is useful for deciding when to show session instructions
 * 
 * @param sessionId The session ID to check
 * @returns Boolean indicating if this appears to be a session ID in our format
 */
export function isStandardSessionId(sessionId: string): boolean {
    // Check if it follows our s-YYYYMMDDhhmmss format
    return /^s-\d{14}$/.test(sessionId);
}

/**
 * Enhances a context string with session instructions
 * 
 * @param sessionId The session ID to include in instructions
 * @param contextString The original context string
 * @returns Enhanced context string with instructions
 */
export function enhanceContextWithSessionInstructions(
    sessionId: string, 
    contextString?: string
): string {
    const instructions = formatSessionInstructions(sessionId);
    if (!contextString) {
        return instructions;
    }
    return `${instructions}\n\n${contextString}`;
}