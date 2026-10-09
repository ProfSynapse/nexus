/**
 * ReasoningSegmentSplitter Unit Tests
 *
 * The splitter places one combined Thinking section in an assistant turn while
 * preserving the visible answer text and its order.
 */

import { ReasoningSegmentSplitter } from '../../src/ui/chat/components/helpers/ReasoningSegmentSplitter';

describe('ReasoningSegmentSplitter', () => {
  it('collapses excess blank display lines within and between tool rounds without modifying stored text', () => {
    const segments = [
      { text: 'First thought.\r\n\r\n\r\n  \r\nNext paragraph.\n\n', contentOffset: 0 },
      { text: '\n\nSecond round.', contentOffset: 5 }
    ];
    const original = JSON.stringify(segments);
    expect(ReasoningSegmentSplitter.combine(segments, undefined)).toBe('First thought.\n\nNext paragraph.\n\nSecond round.');
    expect(JSON.stringify(segments)).toBe(original);
    expect(ReasoningSegmentSplitter.split('Answer', undefined, 'One\n\n\n\nTwo')[0].reasoning?.text).toBe('One\n\nTwo');
  });
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

  it('combines thinking across rounds into one section without duplicating answer text', () => {
    const content = 'Step one. Step two.';
    const parts = ReasoningSegmentSplitter.split(
      content,
      [
        { text: 'First thought', contentOffset: 0 },
        { text: 'Second thought', contentOffset: 'Step one.'.length }
      ],
      'First thoughtSecond thought'
    );

    expect(parts).toEqual([{
      reasoning: { text: 'First thought\n\nSecond thought', contentOffset: 0 },
      reasoningIndex: 0,
      text: content
    }]);
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

  it('combines repeated reasoning boundaries with interleaved text and tool rounds', () => {
    const answer = 'Checking first source. Checking second source. Final answer.';
    const segments = [
      { text: 'Find the first source.', contentOffset: 0 },
      { text: 'Compare tool result with second source.', contentOffset: 22 },
      { text: 'Stitch the two findings.', contentOffset: 46 }
    ];

    const parts = ReasoningSegmentSplitter.split(answer, segments, segments.map(s => s.text).join(''));

    expect(parts.filter(part => part.reasoning)).toHaveLength(1);
    expect(parts[0].reasoning?.text).toBe(segments.map(s => s.text).join('\n\n'));
    expect(parts.map(part => part.text).join('')).toBe(answer);
    expect(segments).toEqual([
      { text: 'Find the first source.', contentOffset: 0 },
      { text: 'Compare tool result with second source.', contentOffset: 22 },
      { text: 'Stitch the two findings.', contentOffset: 46 }
    ]);
  });
});
