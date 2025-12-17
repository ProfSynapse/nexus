/**
 * Type definitions for streaming markdown state
 */

import type { Parser, Default_Renderer } from 'streaming-markdown';

/**
 * Streaming state for a message being rendered with streaming-markdown
 */
export interface StreamingState {
  parser: Parser;
  renderer: Default_Renderer;
  contentDiv: HTMLElement;
}

/**
 * Extended Element interface to support legacy loading interval storage
 */
export interface ElementWithLoadingInterval extends Element {
  _loadingInterval?: NodeJS.Timeout;
}
