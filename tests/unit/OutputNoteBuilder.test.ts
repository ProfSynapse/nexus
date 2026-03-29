/**
 * OutputNoteBuilder Unit Tests
 *
 * Tests the pure functions that build markdown output notes
 * from PDF page content and audio transcription segments.
 */

import {
  buildPdfNote,
  buildAudioNote,
} from '../../src/agents/ingestManager/tools/services/OutputNoteBuilder';
import { PdfPageContent, TranscriptionSegment } from '../../src/agents/ingestManager/types';

describe('OutputNoteBuilder', () => {
  // ==========================================================================
  // buildPdfNote
  // ==========================================================================

  describe('buildPdfNote', () => {
    it('should start with ![[filename]] embed on first line', () => {
      const pages: PdfPageContent[] = [{ pageNumber: 1, text: 'Hello' }];
      const result = buildPdfNote('report.pdf', pages);
      expect(result.startsWith('![[report.pdf]]')).toBe(true);
    });

    it('should have a blank line after the embed', () => {
      const pages: PdfPageContent[] = [{ pageNumber: 1, text: 'Hello' }];
      const result = buildPdfNote('report.pdf', pages);
      const lines = result.split('\n');
      expect(lines[0]).toBe('![[report.pdf]]');
      expect(lines[1]).toBe('');
    });

    it('should not include page headings for single-page PDFs', () => {
      const pages: PdfPageContent[] = [{ pageNumber: 1, text: 'Single page content' }];
      const result = buildPdfNote('one-pager.pdf', pages);
      expect(result).not.toContain('## Page');
    });

    it('should include page headings for multi-page PDFs', () => {
      const pages: PdfPageContent[] = [
        { pageNumber: 1, text: 'First page' },
        { pageNumber: 2, text: 'Second page' },
      ];
      const result = buildPdfNote('multi.pdf', pages);
      expect(result).toContain('## Page 1');
      expect(result).toContain('## Page 2');
    });

    it('should include page text after headings', () => {
      const pages: PdfPageContent[] = [
        { pageNumber: 1, text: 'Introduction text' },
        { pageNumber: 2, text: 'Body text here' },
      ];
      const result = buildPdfNote('doc.pdf', pages);
      const lines = result.split('\n');
      const page1Index = lines.indexOf('## Page 1');
      expect(lines[page1Index + 2]).toBe('Introduction text');
    });

    it('should handle empty page text gracefully', () => {
      const pages: PdfPageContent[] = [
        { pageNumber: 1, text: '' },
        { pageNumber: 2, text: 'Content here' },
      ];
      const result = buildPdfNote('mixed.pdf', pages);
      expect(result).toContain('## Page 1');
      expect(result).toContain('## Page 2');
      expect(result).toContain('Content here');
    });

    it('should end with a single newline', () => {
      const pages: PdfPageContent[] = [{ pageNumber: 1, text: 'Content' }];
      const result = buildPdfNote('test.pdf', pages);
      expect(result.endsWith('\n')).toBe(true);
      expect(result.endsWith('\n\n')).toBe(false);
    });

    it('should handle special characters in filename', () => {
      const pages: PdfPageContent[] = [{ pageNumber: 1, text: 'Content' }];
      const result = buildPdfNote('my report (final) [v2].pdf', pages);
      expect(result).toContain('![[my report (final) [v2].pdf]]');
    });

    it('should handle many pages', () => {
      const pages: PdfPageContent[] = Array.from({ length: 50 }, (_, i) => ({
        pageNumber: i + 1,
        text: `Page ${i + 1} content`,
      }));
      const result = buildPdfNote('big.pdf', pages);
      expect(result).toContain('## Page 1');
      expect(result).toContain('## Page 50');
      expect(result).toContain('Page 25 content');
    });

    it('should handle empty pages array', () => {
      const result = buildPdfNote('empty.pdf', []);
      expect(result).toBe('![[empty.pdf]]\n');
    });
  });

  // ==========================================================================
  // buildAudioNote
  // ==========================================================================

  describe('buildAudioNote', () => {
    it('should start with ![[filename]] embed on first line', () => {
      const segments: TranscriptionSegment[] = [
        { startSeconds: 0, endSeconds: 5, text: 'Hello' },
      ];
      const result = buildAudioNote('recording.mp3', segments);
      expect(result.startsWith('![[recording.mp3]]')).toBe(true);
    });

    it('should have a blank line after the embed', () => {
      const segments: TranscriptionSegment[] = [
        { startSeconds: 0, endSeconds: 5, text: 'Hello' },
      ];
      const result = buildAudioNote('recording.mp3', segments);
      const lines = result.split('\n');
      expect(lines[1]).toBe('');
    });

    it('should format timestamps as [HH:MM:SS]', () => {
      const segments: TranscriptionSegment[] = [
        { startSeconds: 0, endSeconds: 5, text: 'Start' },
        { startSeconds: 61, endSeconds: 120, text: 'One minute in' },
        { startSeconds: 3661, endSeconds: 3700, text: 'Over an hour' },
      ];
      const result = buildAudioNote('audio.mp3', segments);
      expect(result).toContain('[00:00:00] Start');
      expect(result).toContain('[00:01:01] One minute in');
      expect(result).toContain('[01:01:01] Over an hour');
    });

    it('should handle fractional seconds (floor)', () => {
      const segments: TranscriptionSegment[] = [
        { startSeconds: 1.5, endSeconds: 3.9, text: 'Fractional' },
      ];
      const result = buildAudioNote('audio.mp3', segments);
      expect(result).toContain('[00:00:01] Fractional');
    });

    it('should handle zero-based timestamps', () => {
      const segments: TranscriptionSegment[] = [
        { startSeconds: 0, endSeconds: 1, text: 'Beginning' },
      ];
      const result = buildAudioNote('audio.mp3', segments);
      expect(result).toContain('[00:00:00] Beginning');
    });

    it('should end with a single newline', () => {
      const segments: TranscriptionSegment[] = [
        { startSeconds: 0, endSeconds: 5, text: 'Hello' },
      ];
      const result = buildAudioNote('audio.mp3', segments);
      expect(result.endsWith('\n')).toBe(true);
      expect(result.endsWith('\n\n')).toBe(false);
    });

    it('should handle empty segments array', () => {
      const result = buildAudioNote('empty.mp3', []);
      expect(result).toBe('![[empty.mp3]]\n');
    });

    it('should handle long timestamps (24+ hours)', () => {
      const segments: TranscriptionSegment[] = [
        { startSeconds: 90061, endSeconds: 90120, text: 'Way later' },
      ];
      const result = buildAudioNote('long.mp3', segments);
      // 90061 seconds = 25h 1m 1s
      expect(result).toContain('[25:01:01] Way later');
    });

    it('should preserve text with special characters', () => {
      const segments: TranscriptionSegment[] = [
        { startSeconds: 0, endSeconds: 5, text: 'He said "hello" & waved' },
      ];
      const result = buildAudioNote('audio.mp3', segments);
      expect(result).toContain('[00:00:00] He said "hello" & waved');
    });

    it('should handle multiple segments in sequence', () => {
      const segments: TranscriptionSegment[] = [
        { startSeconds: 0, endSeconds: 10, text: 'First segment' },
        { startSeconds: 10, endSeconds: 20, text: 'Second segment' },
        { startSeconds: 20, endSeconds: 30, text: 'Third segment' },
      ];
      const result = buildAudioNote('multi.mp3', segments);
      const lines = result.split('\n');
      // line 0: embed, line 1: blank, line 2-4: segments
      expect(lines[2]).toBe('[00:00:00] First segment');
      expect(lines[3]).toBe('[00:00:10] Second segment');
      expect(lines[4]).toBe('[00:00:20] Third segment');
    });
  });
});
