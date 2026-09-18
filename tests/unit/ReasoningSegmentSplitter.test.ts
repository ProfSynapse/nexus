/**
 * ReasoningSegmentSplitter Unit Tests
 *
 * The splitter decides where each "Thinking" block lands in an assistant turn.
 * Get it wrong and either the answer text is duplicated, silently truncated, or
 * every thought stacks at the top of the bubble again.
 */

import { ReasoningSegmentSplitter } from '../../src/ui/chat/components/helpers/ReasoningSegmentSplitter';

describe('ReasoningSegmentSplitter', () => {
  it('renders a lone text run when the turn never reasoned', () => {
    expect(ReasoningSegmentSplitter.split('Just an answer.', undefined, undefined)).toEqual([
      { text: 'Just an answer.' }
    ]);
  });

  it('falls back to one leading block for a message stored before segments existed', () => {
    const parts = ReasoningSegmentSplitter.split('Answer', undefined, 'Legacy thinking');

    expect(parts).toEqual([
      { reasoning: { text: 'Legacy thinking', contentOffset: 0 }, reasoningIndex: 0, text: 'Answer' }
    ]);
  });

  it('puts each thinking block above the text it preceded', () => {
    const content = 'Step one. Step two.';
    const parts = ReasoningSegmentSplitter.split(
      content,
      [
        { text: 'First thought', contentOffset: 0 },
        { text: 'Second thought', contentOffset: 'Step one.'.length }
      ],
      'First thoughtSecond thought'
    );

    expect(parts).toEqual([
      {
        reasoning: { text: 'First thought', contentOffset: 0 },
        reasoningIndex: 0,
        text: 'Step one.'
      },
      {
        reasoning: { text: 'Second thought', contentOffset: 9 },
        reasoningIndex: 1,
        text: ' Step two.'
      }
    ]);
    // Nothing is lost or repeated: the runs still reassemble the answer
    expect(parts.map(part => part.text).join('')).toBe(content);
  });

  it('keeps text that streamed before the model first thought', () => {
    const parts = ReasoningSegmentSplitter.split(
      'Opening. Rest.',
      [{ text: 'Mid-turn thought', contentOffset: 'Opening.'.length }],
      'Mid-turn thought'
    );

    expect(parts[0]).toEqual({ text: 'Opening.' });
    expect(parts[1].reasoning?.text).toBe('Mid-turn thought');
    expect(parts[1].text).toBe(' Rest.');
  });

  it('clamps an offset that outran the content instead of dropping text', () => {
    const parts = ReasoningSegmentSplitter.split(
      'Short',
      [{ text: 'Stale anchor', contentOffset: 9999 }],
      'Stale anchor'
    );

    expect(parts.map(part => part.text).join('')).toBe('Short');
  });

  it('forces offsets non-decreasing so an out-of-order segment cannot duplicate text', () => {
    const parts = ReasoningSegmentSplitter.split(
      'abcdef',
      [
        { text: 'first', contentOffset: 4 },
        { text: 'second', contentOffset: 1 }
      ],
      'firstsecond'
    );

    expect(parts.map(part => part.text).join('')).toBe('abcdef');
  });

  it('ignores blank segments so an empty block never renders', () => {
    const parts = ReasoningSegmentSplitter.split(
      'Answer',
      [{ text: '   ', contentOffset: 0 }],
      '   '
    );

    expect(parts).toEqual([{ text: 'Answer' }]);
  });
});
