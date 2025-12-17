/**
 * MessageContentRenderer - Renders message content with markdown and references
 * Location: /src/ui/chat/components/renderers/MessageContentRenderer.ts
 *
 * This class is responsible for:
 * - Rendering message content using Obsidian's markdown renderer
 * - Processing and injecting reference badges
 * - Handling rendering errors with fallback to plain text
 *
 * Used by MessageBubble to render enhanced markdown content with
 * interactive reference badges for tools, agents, and notes.
 */

import { App, Component } from 'obsidian';
import { MarkdownRenderer } from '../../utils/MarkdownRenderer';
import { ReferenceMetadata } from '../../utils/ReferenceExtractor';
import { ReferenceBadgeRenderer } from './ReferenceBadgeRenderer';

export class MessageContentRenderer {
  /**
   * Render message content with enhanced markdown and reference badges
   */
  static async renderContent(
    container: HTMLElement,
    content: string,
    app: App,
    component: Component,
    referenceMetadata?: ReferenceMetadata
  ): Promise<void> {
    // Skip rendering if content is empty
    if (!content.trim()) {
      return;
    }

    let contentToRender = content;
    let placeholders: any[] | null = null;

    // Inject reference placeholders if metadata exists
    if (referenceMetadata && referenceMetadata.references.length > 0) {
      const transformation = ReferenceBadgeRenderer.injectReferencePlaceholders(
        content,
        referenceMetadata.references
      );
      contentToRender = transformation.content;
      placeholders = transformation.placeholders;
    }

    // Use enhanced markdown renderer with Obsidian's native rendering
    try {
      await MarkdownRenderer.renderMarkdown(contentToRender, container, app, component);
    } catch (error) {
      console.error('[MessageContentRenderer] Error rendering markdown:', error);
      // Fallback to plain text
      const pre = container.createEl('pre', {
        cls: 'markdown-renderer-plaintext'
      });
      pre.textContent = contentToRender;
    }

    // Replace placeholders with badge elements
    if (placeholders && placeholders.length > 0) {
      ReferenceBadgeRenderer.replacePlaceholdersWithBadges(container, placeholders);
    }
  }
}
