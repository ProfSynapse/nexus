/**
 * Utility class for handling link operations
 * Provides methods for normalizing links and finding fuzzy matches
 */
export class LinkUtils {
    /**
     * Normalize link text for more robust matching
     * Removes spaces, special characters, and converts to lowercase
     * 
     * @param linkText The link text to normalize
     * @returns Normalized link text
     */
    normalizeLinkText(linkText: string): string {
        return linkText
            .toLowerCase()
            .replace(/\s+/g, '_')
            .replace(/[^\w\s-]/g, '');
    }
    
    /**
     * Add a filename to the normalized link map
     * 
     * @param linkMap The map to add to
     * @param text The text to normalize and add
     * @param filePath The file path to associate with the text
     */
    addToLinkMap(linkMap: Map<string, string[]>, text: string, filePath: string): void {
        const normalizedText = this.normalizeLinkText(text);
        
        if (!linkMap.has(normalizedText)) {
            linkMap.set(normalizedText, []);
        }
        
        const paths = linkMap.get(normalizedText);
        if (paths && !paths.includes(filePath)) {
            paths.push(filePath);
        }
    }
    
    /**
     * Generate different normalized variants of a link text
     * 
     * @param text The text to generate variants for
     * @returns Array of normalized variants
     */
    getNormalizedVariants(text: string): string[] {
        const variants = new Set<string>();
        
        // Add original
        variants.add(this.normalizeLinkText(text));
        
        // Add with spaces replaced by underscores
        variants.add(this.normalizeLinkText(text.replace(/\s+/g, '_')));
        
        // Add with spaces replaced by hyphens
        variants.add(this.normalizeLinkText(text.replace(/\s+/g, '-')));
        
        // Add without special characters
        variants.add(this.normalizeLinkText(text.replace(/[^\w\s]/g, '')));
        
        // Handle common file extensions (.md)
        const withoutExt = text.endsWith('.md') ? text.slice(0, -3) : text;
        variants.add(this.normalizeLinkText(withoutExt));
        
        return Array.from(variants);
    }
    
    /**
     * Find fuzzy matches for a link text
     * 
     * @param linkMap The normalized link map
     * @param text The text to find fuzzy matches for
     * @returns Array of matching file paths
     */
    findFuzzyMatches(linkMap: Map<string, string[]>, text: string): string[] {
        const matches = new Set<string>();
        const normalizedText = this.normalizeLinkText(text);
        
        // For each key in the map, check if either contains the other
        // Convert to array for compatibility
        Array.from(linkMap.entries()).forEach(([key, paths]) => {
            // If the key contains our text or our text contains the key
            if (key.includes(normalizedText) || normalizedText.includes(key)) {
                paths.forEach(path => matches.add(path));
            }
        });
        
        return Array.from(matches);
    }
}