/**
 * BaseResultFormatter - Base class for result formatting operations
 * Location: /src/agents/searchManager/services/formatters/BaseResultFormatter.ts
 *
 * Provides common formatting functionality shared across all result types.
 * Implements template methods for result formatting with extensibility points.
 *
 * Used by: All specialized result formatters
 */

import {
  MemorySearchResult,
  FormattedMemoryResult,
  FormatOptions,
  FormatContext,
  ResultFormatterConfiguration,
  MemoryType
} from '../../../../types/memory/MemorySearchTypes';

/**
 * Abstract base class for all result formatters
 * Implements common formatting logic with template method pattern
 */
export abstract class BaseResultFormatter {
  protected configuration: ResultFormatterConfiguration;

  constructor(config?: Partial<ResultFormatterConfiguration>) {
    this.configuration = {
      maxHighlightLength: 200,
      contextLength: 50,
      enableToolCallEnhancement: true,
      dateFormat: 'YYYY-MM-DD',
      timestampFormat: 'YYYY-MM-DD HH:mm:ss',
      ...config
    };
  }

  /**
   * Format a single search result
   * Template method - calls extension points for customization
   */
  async formatSingleResult(result: MemorySearchResult, options: FormatOptions): Promise<FormattedMemoryResult> {
    const formatContext: FormatContext = {
      searchQuery: '',
      resultType: result.type,
      timestamp: new Date()
    };

    const formattedContent = this.formatContent(result, options);
    const preview = this.generatePreview(result, options);
    const formattedTimestamp = this.formatTimestamp(result.metadata.created);
    const title = this.generateTitle(result);
    const subtitle = this.generateSubtitle(result);
    const formattedMetadata = this.formatMetadata(result.metadata);

    return {
      original: result,
      formattedContent,
      preview,
      formattedTimestamp,
      title,
      subtitle,
      formattedMetadata,
      highlights: [],
      formatContext
    };
  }

  /**
   * Format result content
   * Can be overridden by subclasses for type-specific formatting
   */
  protected formatContent(result: MemorySearchResult, options: FormatOptions): string {
    let content = result.highlight;

    const maxLength = options.maxHighlightLength || this.configuration.maxHighlightLength;
    if (content.length > maxLength) {
      content = content.substring(0, maxLength - 3) + '...';
    }

    return this.enhanceContent(content, result, options);
  }

  /**
   * Extension point for content enhancement
   * Override in subclasses for type-specific enhancements
   */
  protected enhanceContent(content: string, result: MemorySearchResult, options: FormatOptions): string {
    return content;
  }

  /**
   * Generate preview from result context
   */
  protected generatePreview(result: MemorySearchResult, options: FormatOptions): string {
    const previewLength = 100;
    const content = result.context.before + result.context.match + result.context.after;

    if (content.length <= previewLength) {
      return content;
    }

    return content.substring(0, previewLength - 3) + '...';
  }

  /**
   * Format timestamp string
   */
  protected formatTimestamp(timestamp: string): string {
    try {
      const date = new Date(timestamp);
      return date.toLocaleString();
    } catch (error) {
      return timestamp;
    }
  }

  /**
   * Generate result title
   * Must be implemented by subclasses for type-specific titles
   */
  protected abstract generateTitle(result: MemorySearchResult): string;

  /**
   * Generate result subtitle
   * Can be overridden by subclasses for type-specific subtitles
   */
  protected generateSubtitle(result: MemorySearchResult): string | undefined {
    const metadata = result.metadata;
    const parts: string[] = [];

    if (metadata.type) {
      parts.push(metadata.type);
    }

    if (metadata.filesReferenced && metadata.filesReferenced.length > 0) {
      parts.push(`${metadata.filesReferenced.length} files`);
    }

    return parts.length > 0 ? parts.join(' • ') : undefined;
  }

  /**
   * Format result metadata
   */
  protected formatMetadata(metadata: any): Record<string, string> {
    const formatted: Record<string, string> = {};

    if (metadata.created) {
      formatted['Created'] = this.formatTimestamp(metadata.created);
    }
    if (metadata.updated) {
      formatted['Updated'] = this.formatTimestamp(metadata.updated);
    }
    if (metadata.sessionId) {
      formatted['Session'] = metadata.sessionId;
    }
    if (metadata.workspaceId) {
      formatted['Workspace'] = metadata.workspaceId;
    }

    // Add type-specific fields
    this.addTypeSpecificMetadata(formatted, metadata);

    return formatted;
  }

  /**
   * Extension point for type-specific metadata
   * Override in subclasses to add specialized metadata fields
   */
  protected addTypeSpecificMetadata(formatted: Record<string, string>, metadata: any): void {
    // Base implementation - subclasses can override
  }

  /**
   * Get current configuration
   */
  getConfiguration(): ResultFormatterConfiguration {
    return { ...this.configuration };
  }

  /**
   * Update configuration
   */
  updateConfiguration(config: Partial<ResultFormatterConfiguration>): void {
    this.configuration = { ...this.configuration, ...config };
  }
}
