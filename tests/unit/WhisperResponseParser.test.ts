import { parseWhisperResponse, parseWhisperWords } from '../../src/services/llm/utils/WhisperResponseParser';

describe('WhisperResponseParser', () => {
  describe('parseWhisperResponse', () => {
    it('parses segments with start/end timestamps', () => {
      const data = {
        segments: [
          { start: 0, end: 2.5, text: 'Hello world' },
          { start: 2.5, end: 5.0, text: 'Second segment' }
        ]
      };

      const result = parseWhisperResponse(data, 10);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(expect.objectContaining({
        startSeconds: 0,
        endSeconds: 2.5,
        text: 'Hello world'
      }));
      expect(result[1]).toEqual(expect.objectContaining({
        startSeconds: 2.5,
        endSeconds: 5.0,
        text: 'Second segment'
      }));
    });

    it('falls back to chunkDuration when segment timestamps missing', () => {
      const data = {
        segments: [{ text: 'No timestamps' }]
      };

      const result = parseWhisperResponse(data, 30);
      expect(result[0].startSeconds).toBe(0);
      expect(result[0].endSeconds).toBe(30);
    });

    it('filters out empty-text segments', () => {
      const data = {
        segments: [
          { start: 0, end: 1, text: 'Keep me' },
          { start: 1, end: 2, text: '' },
          { start: 2, end: 3, text: '   ' }
        ]
      };

      const result = parseWhisperResponse(data, 10);
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('Keep me');
    });

    it('falls back to top-level text when no segments', () => {
      const data = { text: 'Fallback text', duration: 7.5 };

      const result = parseWhisperResponse(data, 10);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(expect.objectContaining({
        startSeconds: 0,
        endSeconds: 7.5,
        text: 'Fallback text'
      }));
    });

    it('uses chunkDuration when top-level text and no duration', () => {
      const data = { text: 'No duration field' };

      const result = parseWhisperResponse(data, 15);
      expect(result[0].endSeconds).toBe(15);
    });

    it('returns empty array when no text or segments', () => {
      expect(parseWhisperResponse({}, 10)).toHaveLength(0);
      expect(parseWhisperResponse({ text: '' }, 10)).toHaveLength(0);
      expect(parseWhisperResponse({ text: '   ' }, 10)).toHaveLength(0);
    });

    it('throws on null/undefined data (callers must validate)', () => {
      expect(() => parseWhisperResponse(null, 10)).toThrow();
      expect(() => parseWhisperResponse(undefined, 10)).toThrow();
    });

    describe('options: useLogProbAsConfidence', () => {
      it('extracts avg_logprob as confidence when enabled', () => {
        const data = {
          segments: [{ start: 0, end: 1, text: 'test', avg_logprob: -0.25 }]
        };

        const result = parseWhisperResponse(data, 10, { useLogProbAsConfidence: true });
        expect(result[0].confidence).toBe(-0.25);
      });

      it('ignores avg_logprob when option disabled', () => {
        const data = {
          segments: [{ start: 0, end: 1, text: 'test', avg_logprob: -0.25 }]
        };

        const result = parseWhisperResponse(data, 10);
        expect(result[0].confidence).toBeUndefined();
      });
    });

    describe('options: useSegmentConfidence', () => {
      it('extracts segment confidence when enabled', () => {
        const data = {
          segments: [{ start: 0, end: 1, text: 'test', confidence: 0.95 }]
        };

        const result = parseWhisperResponse(data, 10, { useSegmentConfidence: true });
        expect(result[0].confidence).toBe(0.95);
      });

      it('ignores segment confidence when option disabled', () => {
        const data = {
          segments: [{ start: 0, end: 1, text: 'test', confidence: 0.95 }]
        };

        const result = parseWhisperResponse(data, 10);
        expect(result[0].confidence).toBeUndefined();
      });
    });

    describe('options: extractSpeakers', () => {
      it('extracts speaker labels from segments when enabled', () => {
        const data = {
          segments: [{ start: 0, end: 1, text: 'test', speaker: 'Speaker A' }]
        };

        const result = parseWhisperResponse(data, 10, { extractSpeakers: true });
        expect(result[0].speaker).toBe('Speaker A');
      });

      it('ignores speaker labels when option disabled', () => {
        const data = {
          segments: [{ start: 0, end: 1, text: 'test', speaker: 'Speaker A' }]
        };

        const result = parseWhisperResponse(data, 10);
        expect(result[0].speaker).toBeUndefined();
      });
    });

    it('assigns words to segments by timestamp range', () => {
      const data = {
        segments: [
          { start: 0, end: 2, text: 'Hello world' },
          { start: 2, end: 4, text: 'More text' }
        ],
        words: [
          { word: 'Hello', start: 0, end: 0.5 },
          { word: 'world', start: 0.5, end: 1.5 },
          { word: 'More', start: 2, end: 2.5 },
          { word: 'text', start: 2.5, end: 3.5 }
        ]
      };

      const result = parseWhisperResponse(data, 10);
      expect(result[0].words).toHaveLength(2);
      expect(result[0].words![0].text).toBe('Hello');
      expect(result[0].words![1].text).toBe('world');
      expect(result[1].words).toHaveLength(2);
      expect(result[1].words![0].text).toBe('More');
    });

    it('includes words in text fallback when no segments', () => {
      const data = {
        text: 'Hello world',
        words: [
          { word: 'Hello', start: 0, end: 0.5 },
          { word: 'world', start: 0.5, end: 1.0 }
        ]
      };

      const result = parseWhisperResponse(data, 10);
      expect(result[0].words).toHaveLength(2);
    });
  });

  describe('parseWhisperWords', () => {
    it('parses valid word objects', () => {
      const words = [
        { word: 'Hello', start: 0, end: 0.5, confidence: 0.99 },
        { word: 'world', start: 0.5, end: 1.0 }
      ];

      const result = parseWhisperWords(words);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        text: 'Hello',
        startSeconds: 0,
        endSeconds: 0.5,
        confidence: 0.99,
        speaker: undefined
      });
      expect(result[1].confidence).toBeUndefined();
    });

    it('skips words with missing text', () => {
      const words = [
        { start: 0, end: 0.5 },
        { word: 'valid', start: 0.5, end: 1.0 }
      ];

      const result = parseWhisperWords(words as any);
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('valid');
    });

    it('skips words with missing timestamps', () => {
      const words = [
        { word: 'no-start', end: 0.5 },
        { word: 'no-end', start: 0 },
        { word: 'valid', start: 0, end: 1.0 }
      ];

      const result = parseWhisperWords(words as any);
      expect(result).toHaveLength(1);
    });

    it('extracts speaker labels when extractSpeakers enabled', () => {
      const words = [
        { word: 'Hello', start: 0, end: 0.5, speaker: 'A' }
      ];

      const result = parseWhisperWords(words, { extractSpeakers: true });
      expect(result[0].speaker).toBe('A');
    });

    it('ignores speaker labels when extractSpeakers disabled', () => {
      const words = [
        { word: 'Hello', start: 0, end: 0.5, speaker: 'A' }
      ];

      const result = parseWhisperWords(words);
      expect(result[0].speaker).toBeUndefined();
    });

    it('returns empty array for undefined input', () => {
      expect(parseWhisperWords(undefined)).toEqual([]);
    });

    it('returns empty array for non-array input', () => {
      expect(parseWhisperWords('not-an-array' as any)).toEqual([]);
    });
  });
});
