/**
 * Session utility functions for consistent session management
 * Provides standardized methods for generating and working with session IDs
 */

/**
 * The whole-second UTC timestamp (ms) the last id was issued for, or null
 * before the first call. Module-level so every caller in the process shares
 * one monotonic sequence.
 */
let lastIssuedSecondMs: number | null = null;

/**
 * Format a whole-second UTC timestamp as s-YYYYMMDDhhmmss.
 */
function formatSessionId(secondMs: number): string {
    return `s-${new Date(secondMs).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
}

/**
 * Generate a standardized session ID based on current datetime, strictly
 * increasing within a process.
 *
 * The format has one-second resolution, so two sessions created in the same
 * second used to get the same id and the second `createSession` was a no-op —
 * two handles then pointed at one record (seen live: `nexus-cli` on an unbound
 * call, then `--session live-check`, both `s-20260912194746`). When the clock
 * has not moved past the last issued id, the id is taken from the last one
 * plus one second, computed on a Date so minute/hour/day carry correctly.
 * The `s-` + 14 digits format is unchanged; `isStandardSessionId` still holds.
 *
 * @returns Session ID in the format s-YYYYMMDDhhmmss
 */
export function generateSessionId(): string {
    let secondMs = Math.floor(Date.now() / 1000) * 1000;
    if (lastIssuedSecondMs !== null && secondMs <= lastIssuedSecondMs) {
        secondMs = lastIssuedSecondMs + 1000;
    }
    lastIssuedSecondMs = secondMs;
    return formatSessionId(secondMs);
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