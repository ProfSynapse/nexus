/**
 * ReasoningSegmentSplitter - Interleave a turn's thinking with its visible text
 * Location: /src/ui/chat/components/helpers/ReasoningSegmentSplitter.ts
 *
 * A reasoning model does not think once and then answer. It thinks, writes,
 * calls a tool, thinks again and writes again. The turn stores that thinking as
 * segments anchored to the length of visible content at the moment each one
 * opened; this splitter turns those anchors back into an ordered list of parts,
 * so each block of thinking renders above the text it actually preceded instead
 * of every thought piling into one block at the top of the bubble.
 *
 * Used by MessageBubble to lay out an assistant message's body.
 */

import type { ReasoningSegment } from '../../../../types/chat/ChatTypes';

export interface TurnPart {
  /** Thinking that opened this part, if any. Absent for text before the first thought. */
  reasoning?: ReasoningSegment;
  /** Index of that thinking in the message's `reasoningSegments`. */
  reasoningIndex?: number;
  /** The stretch of visible content that followed it. May be empty. */
  text: string;
}

export class ReasoningSegmentSplitter {
  /**
   * Build the ordered parts of an assistant turn.
   *
   * Falls back to a single leading block when only the legacy flat `reasoning`
   * string is available (messages stored before segments existed, and providers
   * that never split their thinking).
   */
  static split(
    content: string,
    segments: ReasoningSegment[] | undefined,
    reasoning: string | undefined
  ): TurnPart[] {
    const usable = this.normalize(segments, content.length);

    if (usable.length === 0) {
      return reasoning && reasoning.trim()
        ? [{ reasoning: { text: reasoning, contentOffset: 0 }, reasoningIndex: 0, text: content }]
        : [{ text: content }];
    }

    const parts: TurnPart[] = [];

    const leading = content.slice(0, usable[0].offset);
    if (leading) {
      parts.push({ text: leading });
    }

    for (let index = 0; index < usable.length; index++) {
      const end = index + 1 < usable.length ? usable[index + 1].offset : content.length;
      parts.push({
        reasoning: usable[index].segment,
        reasoningIndex: usable[index].index,
        text: content.slice(usable[index].offset, end)
      });
    }

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
  ): Array<{ segment: ReasoningSegment; offset: number; index: number }> {
    if (!segments || segments.length === 0) {
      return [];
    }

    const normalized: Array<{ segment: ReasoningSegment; offset: number; index: number }> = [];
    let previousOffset = 0;

    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      if (!segment || !segment.text || !segment.text.trim()) {
        continue;
      }

      const raw = Number.isFinite(segment.contentOffset) ? segment.contentOffset : 0;
      const offset = Math.min(Math.max(raw, previousOffset), contentLength);
      previousOffset = offset;

      normalized.push({ segment, offset, index });
    }

    return normalized;
  }
}
