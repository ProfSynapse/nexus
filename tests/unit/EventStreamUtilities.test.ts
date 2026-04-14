import {
  buildEventStreamPath,
  stableEventSignature,
  parseEventStreamPath
} from '../../src/database/storage/vaultRoot/EventStreamUtilities';

describe('EventStreamUtilities', () => {
  it('produces stable signatures for nested event objects', () => {
    const left = {
      id: 'event-1',
      data: { b: 2, a: 1 },
      tags: ['x', { z: true, y: false }]
    };
    const right = {
      tags: ['x', { y: false, z: true }],
      data: { a: 1, b: 2 },
      id: 'event-1'
    };

    expect(stableEventSignature(left)).toBe(stableEventSignature(right));
  });

  it('normalizes conversation logical ids and parses stream relative paths', () => {
    expect(buildEventStreamPath('conversations', '///conv_conv_alpha///')).toBe(
      'conversations/conv_alpha.jsonl'
    );

    expect(parseEventStreamPath('conversations/conv_conv_alpha.jsonl')).toEqual({
      category: 'conversations',
      logicalId: 'conv_alpha',
      fileStem: 'conv_conv_alpha',
      fileName: 'conv_conv_alpha.jsonl'
    });

    expect(parseEventStreamPath('workspace/invalid.jsonl')).toBeNull();
  });
});
