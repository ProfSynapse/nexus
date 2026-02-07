/**
 * Location: src/services/embeddings/EmbeddingUtils.ts
 * Purpose: Shared utility functions for the embedding pipeline.
 *
 * Centralizes content preprocessing (frontmatter stripping, whitespace
 * normalization) and hashing (DJB2) so that all consumers -- EmbeddingService,
 * IndexingQueue, QAPairBuilder -- use the same canonical implementations.
 *
 * Relationships:
 * - Used by EmbeddingService, IndexingQueue, QAPairBuilder
 * - Exported via src/services/embeddings/index.ts barrel
 */

/**
 * Preprocess note / conversation content before embedding or hashing.
 *
 * Steps:
 * 1. Strip YAML frontmatter (delimited by `---`)
 * 2. Remove Obsidian image embeds (`![[...]]`)
 * 3. Resolve wiki-link aliases (`[[path|alias]]` -> `alias`)
 * 4. Resolve plain wiki-links (`[[path]]` -> `path`)
 * 5. Collapse whitespace and trim
 * 6. Return null if result is shorter than 10 characters
 * 7. Truncate to 2000 characters (embedding model context limit)
 *
 * @param content - Raw markdown/text content
 * @returns Processed content string, or null if too short after processing
 */
export function preprocessContent(content: string): string | null {
  // Strip frontmatter
  let processed = content.replace(/^---[\s\S]*?---\n?/, '');

  // Strip image embeds, keep link text
  processed = processed
    .replace(/!\[\[.*?\]\]/g, '')                           // Obsidian image embeds
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')          // [[path|alias]] -> alias
    .replace(/\[\[([^\]]+)\]\]/g, '$1');                    // [[path]] -> path

  // Normalize whitespace
  processed = processed.replace(/\s+/g, ' ').trim();

  // Skip if too short
  if (processed.length < 10) {
    return null;
  }

  // Truncate if too long (model context limit)
  const MAX_CHARS = 2000;
  return processed.length > MAX_CHARS
    ? processed.slice(0, MAX_CHARS)
    : processed;
}

/**
 * DJB2 hash function for string content.
 *
 * A fast, deterministic, non-cryptographic hash suitable for change detection.
 * Produces a hex string from the hash value. Collisions are acceptable since
 * this is only used to detect when content has changed, not for security.
 *
 * This is the canonical implementation. All callers in the embedding pipeline
 * should use this function rather than rolling their own hash.
 *
 * @param input - The string to hash
 * @returns Hex string representation of the hash
 */
export function hashContent(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    // hash * 33 + charCode (using bit shift for multiplication)
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  // Convert to unsigned 32-bit integer, then to hex string
  return (hash >>> 0).toString(16);
}

/**
 * Extract all [[wiki-links]] from a text string.
 *
 * Matches the Obsidian wiki-link patterns:
 * - `[[note name]]` -> "note name"
 * - `[[note name|alias]]` -> "note name" (returns the target, not the alias)
 *
 * @param text - Text to scan for wiki-links
 * @returns Deduplicated array of link targets (lowercased)
 */
export function extractWikiLinks(text: string): string[] {
  const pattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  const links = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    links.add(match[1].toLowerCase().trim());
  }

  return Array.from(links);
}
