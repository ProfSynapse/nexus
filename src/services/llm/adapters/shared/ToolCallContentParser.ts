/**
 * ToolCallContentParser
 *
 * Parses tool calls from content that uses various tool call formats
 * commonly used by fine-tuned models (e.g., Nexus tools SFT, WebLLM models).
 *
 * Supported formats:
 *
 * 1. [TOOL_CALLS] format:
 *    "[TOOL_CALLS] [{\"name\": \"tool_name\", \"arguments\": \"{...}\", \"id\": \"abc123\"}]"
 *
 * 2. <tool_call> XML format:
 *    "<tool_call>
 *    {\"name\": \"tool_name\", \"arguments\": {...}}
 *    </tool_call>"
 *
 * This parser extracts these embedded tool calls and converts them to the
 * standard ToolCall format used by the streaming orchestrator.
 *
 * Used by:
 * - LMStudioAdapter (local models via LM Studio)
 * - WebLLMAdapter (native WebGPU models)
 * - OllamaAdapter (Ollama local models)
 */

import { ToolCall } from '../types';

export interface ParsedToolCallResult {
  /** Whether tool calls were found in the content */
  hasToolCalls: boolean;
  /** Extracted tool calls in standard format */
  toolCalls: ToolCall[];
  /** Content with [TOOL_CALLS] prefix and JSON removed (any remaining text) */
  cleanContent: string;
  /** Any text that appeared before [TOOL_CALLS] */
  prefixContent: string;
}

export interface RawToolCall {
  name: string;
  arguments: string;
  id?: string;
}

export class ToolCallContentParser {
  /** Pattern to detect [TOOL_CALLS] prefix */
  private static readonly TOOL_CALLS_PATTERN = /\[TOOL_CALLS\]/;

  /** Pattern to extract JSON array after [TOOL_CALLS] */
  private static readonly TOOL_CALLS_JSON_PATTERN = /\[TOOL_CALLS\]\s*(\[[\s\S]*\])/;

  /** Pattern to strip [/TOOL_CALLS] end tag if present */
  private static readonly END_TAG_PATTERN = /\[\/TOOL_CALLS\]\s*$/;

  /** Pattern to detect <tool_call> XML format */
  private static readonly XML_TOOL_CALL_PATTERN = /<tool_call>/i;

  /** Pattern to extract JSON from <tool_call>...</tool_call> (single or multiple) */
  private static readonly XML_TOOL_CALL_JSON_PATTERN = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;

  /**
   * Check if content contains [TOOL_CALLS] format
   */
  static hasBracketToolCallsFormat(content: string): boolean {
    return this.TOOL_CALLS_PATTERN.test(content);
  }

  /**
   * Check if content contains <tool_call> XML format
   */
  static hasXmlToolCallFormat(content: string): boolean {
    return this.XML_TOOL_CALL_PATTERN.test(content);
  }

  /**
   * Check if content contains any supported tool call format
   */
  static hasToolCallsFormat(content: string): boolean {
    return this.hasBracketToolCallsFormat(content) || this.hasXmlToolCallFormat(content);
  }

  /**
   * Parse content for embedded tool calls
   *
   * @param content - The raw content string that may contain tool calls
   * @returns ParsedToolCallResult with extracted tool calls and cleaned content
   */
  static parse(content: string): ParsedToolCallResult {
    const result: ParsedToolCallResult = {
      hasToolCalls: false,
      toolCalls: [],
      cleanContent: content,
      prefixContent: ''
    };

    if (!content || !this.hasToolCallsFormat(content)) {
      return result;
    }

    // Determine which format is used and delegate to appropriate parser
    if (this.hasXmlToolCallFormat(content)) {
      return this.parseXmlFormat(content);
    }

    if (this.hasBracketToolCallsFormat(content)) {
      return this.parseBracketFormat(content);
    }

    return result;
  }

  /**
   * Parse the [TOOL_CALLS] bracket format
   */
  private static parseBracketFormat(content: string): ParsedToolCallResult {
    const result: ParsedToolCallResult = {
      hasToolCalls: false,
      toolCalls: [],
      cleanContent: content,
      prefixContent: ''
    };

    try {
      // Strip [/TOOL_CALLS] end tag if present before parsing
      const normalizedContent = content.replace(this.END_TAG_PATTERN, '');

      // Find the position of [TOOL_CALLS]
      const toolCallsMatch = normalizedContent.match(this.TOOL_CALLS_PATTERN);
      if (!toolCallsMatch || toolCallsMatch.index === undefined) {
        return result;
      }

      // Extract any content before [TOOL_CALLS]
      result.prefixContent = normalizedContent.slice(0, toolCallsMatch.index).trim();

      // Extract the JSON array after [TOOL_CALLS]
      const jsonMatch = normalizedContent.match(this.TOOL_CALLS_JSON_PATTERN);
      if (!jsonMatch || !jsonMatch[1]) {
        return result;
      }

      const jsonString = jsonMatch[1];

      // Parse the JSON array
      const rawToolCalls: RawToolCall[] = JSON.parse(jsonString);

      if (!Array.isArray(rawToolCalls)) {
        return result;
      }

      // Convert to standard ToolCall format
      result.toolCalls = rawToolCalls.map((rawCall, index) =>
        this.convertToToolCall(rawCall, index)
      );

      result.hasToolCalls = result.toolCalls.length > 0;

      // Clean content: remove [TOOL_CALLS], JSON, and end tag - keep any remaining text
      const afterJson = normalizedContent.slice(
        (jsonMatch.index || 0) + jsonMatch[0].length
      ).trim();

      result.cleanContent = [result.prefixContent, afterJson]
        .filter(Boolean)
        .join('\n')
        .trim();

    } catch (error) {
      console.error('[ToolCallContentParser] Failed to parse bracket format tool calls:', error);
      result.cleanContent = content;
    }

    return result;
  }

  /**
   * Parse the <tool_call> XML format
   * Supports multiple <tool_call>...</tool_call> blocks in content
   */
  private static parseXmlFormat(content: string): ParsedToolCallResult {
    const result: ParsedToolCallResult = {
      hasToolCalls: false,
      toolCalls: [],
      cleanContent: content,
      prefixContent: ''
    };

    try {
      // Find content before first <tool_call>
      const firstMatch = content.match(/<tool_call>/i);
      if (firstMatch && firstMatch.index !== undefined) {
        result.prefixContent = content.slice(0, firstMatch.index).trim();
      }

      // Extract all <tool_call>...</tool_call> blocks
      // Reset regex lastIndex for multiple uses
      const regex = new RegExp(this.XML_TOOL_CALL_JSON_PATTERN.source, 'gi');
      let match;
      let lastMatchEnd = 0;
      const toolCallMatches: { json: string; start: number; end: number }[] = [];

      while ((match = regex.exec(content)) !== null) {
        toolCallMatches.push({
          json: match[1],
          start: match.index,
          end: match.index + match[0].length
        });
        lastMatchEnd = match.index + match[0].length;
      }

      if (toolCallMatches.length === 0) {
        return result;
      }

      // Parse each tool call JSON
      for (let i = 0; i < toolCallMatches.length; i++) {
        const jsonString = toolCallMatches[i].json.trim();

        try {
          const parsed = JSON.parse(jsonString);

          // Handle both single object and array formats
          const toolCallsArray = Array.isArray(parsed) ? parsed : [parsed];

          for (const rawCall of toolCallsArray) {
            result.toolCalls.push(this.convertToToolCall(rawCall, result.toolCalls.length));
          }
        } catch (parseError) {
        }
      }

      result.hasToolCalls = result.toolCalls.length > 0;

      // Clean content: remove all <tool_call>...</tool_call> blocks
      let cleanContent = content;
      // Process in reverse order to preserve indices
      for (let i = toolCallMatches.length - 1; i >= 0; i--) {
        const m = toolCallMatches[i];
        cleanContent = cleanContent.slice(0, m.start) + cleanContent.slice(m.end);
      }

      result.cleanContent = cleanContent.trim();

    } catch (error) {
      console.error('[ToolCallContentParser] Failed to parse XML format tool calls:', error);
      result.cleanContent = content;
    }

    return result;
  }

  /**
   * Convert a raw tool call to the standard ToolCall format
   */
  private static convertToToolCall(raw: RawToolCall, index: number): ToolCall {
    // Generate ID if not provided
    const id = raw.id || `toolcall_${Date.now()}_${index}`;

    // Ensure arguments is a string (may already be JSON string or could be object)
    let argsString: string;
    if (typeof raw.arguments === 'string') {
      argsString = raw.arguments;
    } else {
      argsString = JSON.stringify(raw.arguments);
    }

    return {
      id,
      type: 'function',
      function: {
        name: raw.name,
        arguments: argsString
      }
    };
  }

  /**
   * Parse streaming content incrementally
   * Returns partial result for streaming UI updates
   *
   * @param accumulatedContent - Content accumulated so far in the stream
   * @returns ParsedToolCallResult (may be incomplete if stream is ongoing)
   */
  static parseStreaming(accumulatedContent: string): ParsedToolCallResult & { isComplete: boolean } {
    const result = this.parse(accumulatedContent);

    // Check if tool call content appears complete
    const isComplete = result.hasToolCalls && this.isToolCallComplete(accumulatedContent);

    return {
      ...result,
      isComplete
    };
  }

  /**
   * Check if tool call content appears complete (handles both formats)
   */
  private static isToolCallComplete(content: string): boolean {
    // Check XML format first
    if (this.hasXmlToolCallFormat(content)) {
      return this.isXmlToolCallComplete(content);
    }

    // Check bracket format
    if (this.hasBracketToolCallsFormat(content)) {
      return this.isBracketToolCallComplete(content);
    }

    return false;
  }

  /**
   * Check if a [TOOL_CALLS] bracket format appears complete
   */
  private static isBracketToolCallComplete(content: string): boolean {
    const jsonMatch = content.match(this.TOOL_CALLS_JSON_PATTERN);
    if (!jsonMatch) return false;

    const jsonString = jsonMatch[1];
    try {
      JSON.parse(jsonString);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if <tool_call> XML format appears complete
   */
  private static isXmlToolCallComplete(content: string): boolean {
    // Check if there's a closing </tool_call> tag
    const openTags = (content.match(/<tool_call>/gi) || []).length;
    const closeTags = (content.match(/<\/tool_call>/gi) || []).length;

    if (openTags === 0 || closeTags === 0 || openTags !== closeTags) {
      return false;
    }

    // Verify JSON inside is parseable
    const regex = new RegExp(this.XML_TOOL_CALL_JSON_PATTERN.source, 'gi');
    let match;
    while ((match = regex.exec(content)) !== null) {
      try {
        JSON.parse(match[1].trim());
      } catch {
        return false;
      }
    }

    return true;
  }

  /**
   * Extract tool name from partial streaming content
   * Useful for showing tool call UI before full JSON is received
   */
  static extractPartialToolInfo(content: string): { name?: string; inProgress: boolean } {
    if (!this.hasToolCallsFormat(content)) {
      return { inProgress: false };
    }

    // Try to extract the first tool name even if JSON is incomplete
    // This pattern works for both formats since they both use "name": "..." JSON syntax
    const nameMatch = content.match(/"name"\s*:\s*"([^"]+)"/);

    return {
      name: nameMatch?.[1],
      inProgress: true
    };
  }
}
