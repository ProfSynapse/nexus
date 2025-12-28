/**
 * ReferenceBadgeRenderer - Renders reference badges in message content
 * Location: /src/ui/chat/components/renderers/ReferenceBadgeRenderer.ts
 *
 * This class is responsible for:
 * - Injecting placeholders into content at reference positions
 * - Replacing placeholders with styled badge elements
 * - Safely reading and normalizing reference metadata
 *
 * Used by MessageBubble to render @tool, @agent, and @note references
 * as interactive badges within message content.
 */

import { ExtractedReference, ReferenceMetadata } from '../../utils/ReferenceExtractor';

interface ReferencePlaceholder {
  token: string;
  index: number;
  reference: ExtractedReference;
}

export class ReferenceBadgeRenderer {
  private static readonly PLACEHOLDER_PREFIX = '\uFFF0REF';
  private static readonly PLACEHOLDER_SUFFIX = '\uFFF1';

  /**
   * Safely read and normalize reference metadata from message
   */
  static getReferenceMetadata(metadata: any): ReferenceMetadata | undefined {
    const typedMetadata = metadata as ReferenceMetadata | undefined;
    if (!typedMetadata || !Array.isArray(typedMetadata.references)) {
      return undefined;
    }

    const normalizedReferences = typedMetadata.references
      .map(ref => {
        if (!ref) return null;
        const type = ref.type;
        if (type !== 'tool' && type !== 'prompt' && type !== 'note' && type !== 'workspace') {
          return null;
        }
        const position = typeof ref.position === 'number' ? ref.position : Number(ref.position);
        if (!Number.isFinite(position)) {
          return null;
        }
        if (typeof ref.displayText !== 'string' || typeof ref.technicalName !== 'string') {
          return null;
        }
        return {
          type,
          displayText: ref.displayText,
          technicalName: ref.technicalName,
          position: Math.max(0, position)
        } as ExtractedReference;
      })
      .filter((ref): ref is ExtractedReference => ref !== null);

    if (normalizedReferences.length === 0) {
      return undefined;
    }

    return {
      references: normalizedReferences
    };
  }

  /**
   * Inject placeholders into content for reference positions
   */
  static injectReferencePlaceholders(
    content: string,
    references: ExtractedReference[]
  ): { content: string; placeholders: ReferencePlaceholder[] } {
    if (references.length === 0) {
      return { content, placeholders: [] };
    }

    const sorted = [...references].sort((a, b) => a.position - b.position);
    let cursor = 0;
    let result = '';
    const placeholders: ReferencePlaceholder[] = [];

    sorted.forEach((reference, index) => {
      const boundedPosition = Math.min(Math.max(reference.position, 0), content.length);
      if (boundedPosition > cursor) {
        result += content.slice(cursor, boundedPosition);
        cursor = boundedPosition;
      } else if (boundedPosition < cursor) {
        cursor = boundedPosition;
      }

      const token = `${ReferenceBadgeRenderer.PLACEHOLDER_PREFIX}${index}${ReferenceBadgeRenderer.PLACEHOLDER_SUFFIX}`;
      result += token;
      placeholders.push({
        token,
        index,
        reference
      });

      // Skip the original reference text in the rendered content to avoid duplicates
      const displayTextLength = reference.displayText?.length ?? 0;
      if (displayTextLength > 0) {
        const skipTo = Math.min(content.length, boundedPosition + displayTextLength);
        // Only skip forward (never backward)
        if (skipTo > cursor) {
          cursor = skipTo;
        }
      }
    });

    result += content.slice(cursor);

    return {
      content: result,
      placeholders
    };
  }

  /**
   * Replace placeholder tokens with styled badge elements
   */
  static replacePlaceholdersWithBadges(container: HTMLElement, placeholders: ReferencePlaceholder[]): void {
    if (placeholders.length === 0) {
      return;
    }

    const placeholderMap = new Map<number, ExtractedReference>();
    placeholders.forEach(placeholder => {
      placeholderMap.set(placeholder.index, placeholder.reference);
    });

    const pattern = new RegExp(
      `${ReferenceBadgeRenderer.escapeForRegex(ReferenceBadgeRenderer.PLACEHOLDER_PREFIX)}(\\d+)${ReferenceBadgeRenderer.escapeForRegex(ReferenceBadgeRenderer.PLACEHOLDER_SUFFIX)}`,
      'g'
    );

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodesToProcess: Text[] = [];
    let currentNode = walker.nextNode();
    while (currentNode) {
      const textNode = currentNode as Text;
      const text = textNode.nodeValue ?? '';
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        nodesToProcess.push(textNode);
      }
      currentNode = walker.nextNode();
    }

    nodesToProcess.forEach(node => {
      const originalText = node.nodeValue ?? '';
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      const tokenPattern = new RegExp(pattern, 'g');
      let match: RegExpExecArray | null;

      while ((match = tokenPattern.exec(originalText)) !== null) {
        const matchIndex = match.index;
        if (matchIndex > lastIndex) {
          fragment.appendChild(document.createTextNode(originalText.slice(lastIndex, matchIndex)));
        }

        const placeholderIndex = Number(match[1]);
        const reference = placeholderMap.get(placeholderIndex);

        if (reference) {
          fragment.appendChild(ReferenceBadgeRenderer.createReferenceBadge(reference));
        } else {
          fragment.appendChild(document.createTextNode(match[0]));
        }

        lastIndex = matchIndex + match[0].length;
      }

      if (lastIndex < originalText.length) {
        fragment.appendChild(document.createTextNode(originalText.slice(lastIndex)));
      }

      node.replaceWith(fragment);
    });
  }

  /**
   * Create badge element for a reference
   */
  private static createReferenceBadge(reference: ExtractedReference): HTMLElement {
    const badge = document.createElement('span');
    badge.className = `chat-reference chat-reference-${reference.type}`;
    badge.setAttribute('data-type', reference.type);
    badge.setAttribute('data-name', reference.technicalName);
    badge.textContent = reference.displayText;
    badge.setAttribute('contenteditable', 'false');
    return badge;
  }

  /**
   * Escape special characters for regex
   */
  private static escapeForRegex(value: string): string {
    return value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  }
}
