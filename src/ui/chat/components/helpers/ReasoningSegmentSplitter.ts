/**
 * ReasoningSegmentSplitter - Lay out a turn's thinking and visible text
 * Location: /src/ui/chat/components/helpers/ReasoningSegmentSplitter.ts
 *
 * A reasoning model can think across several tool rounds in one assistant turn.
 * The stored segments retain their original boundaries and offsets, while the
 * display combines their text into one collapsible Thinking section.
 *
 * Used by MessageBubble to lay out an assistant message's body.
 */

import type { ReasoningSegment } from '../../../../types/chat/ChatTypes';

export interface TurnPart {
  /** Combined display thinking, if any. Absent for text before the first thought. */
  reasoning?: ReasoningSegment;
  /** Display block index (always zero for one assistant turn). */
  reasoningIndex?: number;
  /** The stretch of visible content that followed it. May be empty. */
  text: string;
}

export class ReasoningSegmentSplitter {
  /** Combine display text only; signed provider thinking blocks remain untouched. */
  static combine(segments: ReasoningSegment[] | undefined, reasoning: string | undefined): string {
    const text = segments?.filter(segment => segment?.text?.trim()).map(segment => segment.text).join('\n\n');
    // Display-only normalization: pre-wrap would otherwise render every blank
    // line supplied by the model plus the separators between tool rounds.
    // Never alter the stored/signed provider reasoning blocks.
    return (text || reasoning || '').replace(/\r\n?/g, '\n').replace(/\n(?:[\t ]*\n){2,}/g, '\n\n');
  }

  /** Put one Thinking section at the first reasoning offset, preserving text order. */
  static split(
    content: string,
    segments: ReasoningSegment[] | undefined,
    reasoning: string | undefined
  ): TurnPart[] {
    const usable = this.normalize(segments, content.length);

    if (usable.length === 0) {
      return reasoning && reasoning.trim()
        ? [{ reasoning: { text: this.combine(undefined, reasoning), contentOffset: 0 }, reasoningIndex: 0, text: content }]
        : [{ text: content }];
    }

    const leading = content.slice(0, usable[0].offset);
    const parts: TurnPart[] = leading ? [{ text: leading }] : [];
    parts.push({
      reasoning: { text: this.combine(usable.map(item => item.segment), reasoning), contentOffset: usable[0].offset },
      reasoningIndex: 0,
      text: content.slice(usable[0].offset)
    });
    return parts;
  }

  /**
   * Clamp offsets into the content and force them non-decreasing. Offsets come
   * from a live stream that a retry or an edit can shorten, so a stale anchor
   * past the end of the content must not silently drop text.
   */
  private static normalize(
    segments: ReasoningSegment[] | undefined,
    contentLength: number
  ): Array<{ segment: ReasoningSegment; offset: number }> {
    if (!segments || segments.length === 0) {
      return [];
    }

    const normalized: Array<{ segment: ReasoningSegment; offset: number }> = [];
    let previousOffset = 0;

    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      if (!segment || !segment.text || !segment.text.trim()) {
        continue;
      }

      const raw = Number.isFinite(segment.contentOffset) ? segment.contentOffset : 0;
      const offset = Math.min(Math.max(raw, previousOffset), contentLength);
      previousOffset = offset;

      normalized.push({ segment, offset });
    }

    return normalized;
  }
}
