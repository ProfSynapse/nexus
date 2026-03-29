import { DEFAULT_GRAPH_BOOST_FACTOR, DEFAULT_GRAPH_MAX_DISTANCE } from './constants';
import { LinkUtils } from './LinkUtils';

// Types needed for graph operations
interface searchRecord {
    id: string;
    filePath: string;
    content: string;
    metadata: {
        links?: {
            outgoing: Array<{
                displayText: string;
                targetPath: string;
            }>;
            incoming: Array<{
                sourcePath: string;
                displayText: string;
            }>;
        };
        [key: string]: unknown;
    };
}

interface GraphOptions {
    useGraphBoost: boolean;
    boostFactor?: number;
    includeNeighbors?: boolean;
    maxDistance?: number;
    seedNotes?: string[];
}

/**
 * Handles graph-based operations for relevance boosting
 */
export class GraphOperations {
    private linkUtils: LinkUtils;
    
    constructor() {
        this.linkUtils = new LinkUtils();
    }
    
    /**
     * Apply graph-based boost to search results
     * Increases scores for records that are connected to high-scoring records
     * 
     * @param records Records with similarity scores
     * @param graphOptions Graph boosting options
     */
    applyGraphBoost(
        records: Array<{ record: searchRecord; similarity: number }>,
        graphOptions: GraphOptions
    ): Array<{ record: searchRecord; similarity: number }> {
        const boostFactor = graphOptions.boostFactor || DEFAULT_GRAPH_BOOST_FACTOR;
        const maxDistance = graphOptions.maxDistance || DEFAULT_GRAPH_MAX_DISTANCE;
        const seedNotes = graphOptions.seedNotes || [];
        
        // If no records, return as-is
        if (!records.length) {
            return records;
        }
        
        // If not using graph boost, return as-is
        if (!graphOptions.useGraphBoost) {
            return records;
        }
        
        // Create a graph of connections
        const graph = this.buildConnectionGraph(records);
        
        // Apply boost to seed notes if specified
        let resultsearchs = records;
        if (seedNotes.length > 0) {
            resultsearchs = this.applySeedBoost(resultsearchs, seedNotes);
        }
        
        // Apply multi-level graph boosting
        // Start with initial scores
        const currentScores = new Map<string, number>();
        resultsearchs.forEach(item => {
            currentScores.set(item.record.filePath, item.similarity);
        });
        
        // Apply boost for each level of depth up to maxDistance
        for (let distance = 1; distance <= maxDistance; distance++) {
            const nextScores = new Map<string, number>();
            
            // Start with current scores - convert to array for compatibility
            Array.from(currentScores.entries()).forEach(([filePath, score]) => {
                nextScores.set(filePath, score);
            });
            
            // Apply boost for this distance level - convert to array for compatibility
            Array.from(currentScores.entries()).forEach(([filePath, score]) => {
                const connections = graph.get(filePath) || new Set<string>();
                const levelBoostFactor = boostFactor / distance; // Reduce boost for higher distances
                
                connections.forEach(connectedPath => {
                    // Only boost if the connected path is in our results
                    if (currentScores.has(connectedPath)) {
                        const currentScore = nextScores.get(connectedPath) || 0;
                        // Add a boost proportional to this file's score
                        const boost = score * levelBoostFactor;
                        nextScores.set(connectedPath, currentScore + boost);
                    }
                });
            });
            
            // Update current scores for next iteration
            currentScores.clear();
            // We need to manually copy the values to avoid TypeScript errors
            const entries = Array.from(nextScores.entries());
            for (let i = 0; i < entries.length; i++) {
                const [key, value] = entries[i];
                currentScores.set(key, value);
            }
        }
        
        // Apply final boosted scores
        return resultsearchs.map(item => {
            const filePath = item.record.filePath;
            const boostedScore = currentScores.get(filePath) || item.similarity;
            return {
                record: item.record,
                similarity: boostedScore
            };
        });
    }
    
    /**
     * Apply seed note boosting to search results
     * @param records Records with similarity scores
     * @param seedNotes Array of seed note paths
     */
    applySeedBoost(
        records: Array<{ record: searchRecord; similarity: number }>,
        seedNotes: string[]
    ): Array<{ record: searchRecord; similarity: number }> {
        // If no seed notes, return as-is
        if (!seedNotes.length) {
            return records;
        }
        
        // Create a set of seed note paths for quick lookup
        const seedNoteSet = new Set(seedNotes);
        
        // Create a map of file paths to base name (without extension) for fuzzy matching
        const fileBaseNames = new Map<string, string>();
        records.forEach(item => {
            const baseName = item.record.filePath.split('/').pop()?.replace(/\.[^/.]+$/, '') || '';
            fileBaseNames.set(item.record.filePath, baseName.toLowerCase());
        });
        
        // Create a set of normalized seed note names for fuzzy matching
        const normalizedSeedNames = new Set<string>();
        seedNotes.forEach(path => {
            const baseName = path.split('/').pop()?.replace(/\.[^/.]+$/, '') || '';
            normalizedSeedNames.add(baseName.toLowerCase());
        });
        
        // Apply boost to seed notes and their connections
        return records.map(item => {
            let boostFactor = 1.0; // No boost by default
            
            // Direct exact match with seed note
            if (seedNoteSet.has(item.record.filePath)) {
                boostFactor = 1.5; // 50% boost for direct seed note match
            } 
            // Fuzzy match with seed note name
            else if (normalizedSeedNames.has(fileBaseNames.get(item.record.filePath) || '')) {
                boostFactor = 1.3; // 30% boost for fuzzy seed note match
            }
            
            return {
                record: item.record,
                similarity: item.similarity * boostFactor
            };
        });
    }
    
    /**
     * Build a graph of connections between documents
     * @param records Records with similarity scores
     * @returns Map of file paths to sets of connected file paths
     */
    private buildConnectionGraph(
        records: Array<{ record: searchRecord; similarity: number }>
    ): Map<string, Set<string>> {
        // Create a graph of connections
        const graph = new Map<string, Set<string>>();
        
        // Create a map of normalized link text to file paths
        // This helps with resolving unresolved links
        const normalizedLinkMap = new Map<string, string[]>();
        const fullPathMap = new Map<string, string>(); // Map from filename to full path
        
        // First pass: build normalized link map
        records.forEach(item => {
            const filePath = item.record.filePath;
            const fileName = filePath.split('/').pop() || '';
            const baseName = fileName.replace(/\.[^/.]+$/, '');
            
            // Store multiple ways to reference this file
            this.linkUtils.addToLinkMap(normalizedLinkMap, baseName, filePath);
            this.linkUtils.addToLinkMap(normalizedLinkMap, fileName, filePath);
            
            // Also store the path components
            const pathParts = filePath.split('/');
            pathParts.forEach(part => {
                if (part && part !== baseName && part !== fileName) {
                    this.linkUtils.addToLinkMap(normalizedLinkMap, part, filePath);
                }
            });
            
            // Add to full path map
            fullPathMap.set(fileName, filePath);
            fullPathMap.set(baseName, filePath);
            
            // Initialize graph
            if (!graph.has(filePath)) {
                graph.set(filePath, new Set<string>());
            }
        });
        
        // Second pass: process links from metadata
        records.forEach(item => {
            const filePath = item.record.filePath;
            const links = item.record.metadata.links;
            
            if (!links) {
                return;
            }
            
            // Process outgoing links
            if (links.outgoing && links.outgoing.length > 0) {
                links.outgoing.forEach(link => {
                    const targetPath = link.targetPath;
                    
                    // Ensure source node exists in graph
                    if (!graph.has(filePath)) {
                        graph.set(filePath, new Set<string>());
                    }
                    
                    // Add direct link
                    const connections = graph.get(filePath);
                    connections?.add(targetPath);
                    
                    // Ensure target node exists in graph (bidirectional connection)
                    if (!graph.has(targetPath)) {
                        graph.set(targetPath, new Set<string>());
                    }
                    
                    // Add reverse link
                    const targetConnections = graph.get(targetPath);
                    targetConnections?.add(filePath);
                });
            }
            
            // Process incoming links
            if (links.incoming && links.incoming.length > 0) {
                links.incoming.forEach(link => {
                    const sourcePath = link.sourcePath;
                    
                    // Ensure target node exists in graph
                    if (!graph.has(filePath)) {
                        graph.set(filePath, new Set<string>());
                    }
                    
                    // Add reverse link
                    const connections = graph.get(filePath);
                    connections?.add(sourcePath);
                    
                    // Ensure source node exists in graph (bidirectional connection)
                    if (!graph.has(sourcePath)) {
                        graph.set(sourcePath, new Set<string>());
                    }
                    
                    // Add direct link
                    const sourceConnections = graph.get(sourcePath);
                    sourceConnections?.add(filePath);
                });
            }
        });
        
        // Third pass: process unresolved links and content links
        records.forEach(item => {
            const filePath = item.record.filePath;
            const content = item.record.content || '';
            
            // Extract potential link mentions from content (using a mock implementation)
            const potentialLinks: string[] = [];
            // This is a simple regex to find potential links in markdown/wikilinks syntax
            const linkRegex = /\[\[([^\]]+)\]\]|\[([^\]]+)\]\([^)]+\)/g;
            let match;
            while ((match = linkRegex.exec(content)) !== null) {
                potentialLinks.push(match[1] || match[2]);
            }
            
            potentialLinks.forEach((linkText: string) => {
                const normalizedLink = this.linkUtils.normalizeLinkText(linkText);
                
                // Try to resolve link from our normalized link map
                const matchingPaths = normalizedLinkMap.get(normalizedLink) || [];
                
                matchingPaths.forEach(targetPath => {
                    // Skip self-links
                    if (targetPath === filePath) {
                        return;
                    }
                    
                    // Add to graph
                    const connections = graph.get(filePath) || new Set<string>();
                    connections.add(targetPath);
                    graph.set(filePath, connections);
                    
                    // Add reverse connection
                    const targetConnections = graph.get(targetPath) || new Set<string>();
                    targetConnections.add(filePath);
                    graph.set(targetPath, targetConnections);
                });
            });
        });
        
        return graph;
    }
}