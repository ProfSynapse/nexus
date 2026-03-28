/**
 * Location: src/services/llm/utils/WebSearchUtils.ts
 * Summary: Utility functions for web search source extraction and formatting
 * Used by: LLM adapters for standardized source extraction and markdown formatting
 */

import { SearchResult, SupportedProvider } from '../adapters/types';

const WEB_SEARCH_SUPPORTED_PROVIDERS = [
  'perplexity',
  'openrouter',
  'openai',
  'google',
  'anthropic',
  'groq',
  'mistral'
] as const satisfies readonly SupportedProvider[];

export class WebSearchUtils {
  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private static isScalarField(value: unknown): value is string | number | boolean | bigint {
    return typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint';
  }

  private static normalizeRequiredField(value: unknown): string | null {
    if (!value || !this.isScalarField(value)) {
      return null;
    }

    const normalizedValue = String(value).trim();
    return normalizedValue.length > 0 ? normalizedValue : null;
  }

  private static normalizeOptionalField(value: unknown): string | undefined {
    if (!value || !this.isScalarField(value)) {
      return undefined;
    }

    const normalizedValue = String(value).trim();
    return normalizedValue.length > 0 ? normalizedValue : undefined;
  }

  /**
   * Format web search sources as markdown
   */
  static formatSourcesAsMarkdown(sources: SearchResult[]): string {
    if (!sources || sources.length === 0) {
      return '';
    }

    return sources
      .map(source =>
        `- [${source.title}](${source.url})${source.date ? ` - ${source.date}` : ''}`
      )
      .join('\n');
  }

  /**
   * Validate and normalize a search result
   */
  static validateSearchResult(result: unknown): SearchResult | null {
    if (!this.isRecord(result)) {
      return null;
    }

    const title = this.normalizeRequiredField(result.title);
    const url = this.normalizeRequiredField(result.url);

    if (!title || !url) {
      return null;
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return null;
    }

    return {
      title,
      url,
      date: this.normalizeOptionalField(result.date)
    };
  }

  /**
   * Extract and validate multiple search results
   */
  static extractSearchResults(results: unknown): SearchResult[] {
    if (!Array.isArray(results)) {
      return [];
    }

    return results
      .map(result => this.validateSearchResult(result))
      .filter((result): result is SearchResult => result !== null);
  }

  /**
   * Generate sources section for markdown content
   */
  static generateSourcesSection(sources: SearchResult[]): string {
    if (!sources || sources.length === 0) {
      return '';
    }

    const sourcesMarkdown = this.formatSourcesAsMarkdown(sources);
    return `\n\n---\n\n## Sources\n\n${sourcesMarkdown}`;
  }

  /**
   * Check if provider supports web search
   */
  static isWebSearchSupported(provider: string): boolean {
    return WEB_SEARCH_SUPPORTED_PROVIDERS.includes(provider.toLowerCase() as typeof WEB_SEARCH_SUPPORTED_PROVIDERS[number]);
  }

  /**
   * Validate web search request
   */
  static validateWebSearchRequest(provider: string, webSearchRequested: boolean): void {
    if (webSearchRequested && !this.isWebSearchSupported(provider)) {
      throw new Error(
        `Web search not supported by ${provider}. ` +
        `Supported providers: ${WEB_SEARCH_SUPPORTED_PROVIDERS.join(', ')}`
      );
    }
  }
}