/**
 * Utility for standardized recommendation injection into mode results
 * Used across agents to provide consistent recommendation arrays in MCP responses
 */

export interface Recommendation {
	type: string;
	message: string;
}

/**
 * Adds recommendations array to any mode result object
 * @param result - The base result object from a mode execution
 * @param recommendations - Array of recommendations to inject
 * @returns Enhanced result with recommendations field
 */
export function addRecommendations<T extends object>(
	result: T,
	recommendations: Recommendation[]
): T & { recommendations: Recommendation[] } {
	return { ...result, recommendations };
}
