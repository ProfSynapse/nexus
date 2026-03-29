/**
 * FileTypeDetector Unit Tests
 *
 * Tests the pure file type detection utility.
 * detectFileType, getSupportedExtensions, isSupportedFile.
 */

import {
  detectFileType,
  getSupportedExtensions,
  isSupportedFile,
} from '../../src/agents/ingestManager/tools/services/FileTypeDetector';

describe('FileTypeDetector', () => {
  // ==========================================================================
  // detectFileType — PDF
  // ==========================================================================

  describe('detectFileType - PDF', () => {
    it('should detect .pdf files', () => {
      const result = detectFileType('document.pdf');
      expect(result).toEqual({
        type: 'pdf',
        mimeType: 'application/pdf',
        extension: '.pdf',
      });
    });

    it('should detect .PDF (case-insensitive)', () => {
      const result = detectFileType('document.PDF');
      expect(result).toEqual({
        type: 'pdf',
        mimeType: 'application/pdf',
        extension: '.pdf',
      });
    });

    it('should detect PDF in nested paths', () => {
      const result = detectFileType('folder/subfolder/report.pdf');
      expect(result).toEqual({
        type: 'pdf',
        mimeType: 'application/pdf',
        extension: '.pdf',
      });
    });
  });

  // ==========================================================================
  // detectFileType — Audio
  // ==========================================================================

  describe('detectFileType - Audio', () => {
    it.each([
      ['.mp3', 'audio/mpeg'],
      ['.wav', 'audio/wav'],
      ['.m4a', 'audio/mp4'],
      ['.aac', 'audio/aac'],
      ['.ogg', 'audio/ogg'],
      ['.opus', 'audio/opus'],
      ['.flac', 'audio/flac'],
      ['.webm', 'audio/webm'],
      ['.mp4', 'audio/mp4'],
      ['.wma', 'audio/x-ms-wma'],
    ])('should detect %s as audio with mimeType %s', (ext, expectedMime) => {
      const result = detectFileType(`recording${ext}`);
      expect(result).toEqual({
        type: 'audio',
        mimeType: expectedMime,
        extension: ext,
      });
    });

    it('should detect audio extensions case-insensitively', () => {
      const result = detectFileType('song.MP3');
      expect(result).toEqual({
        type: 'audio',
        mimeType: 'audio/mpeg',
        extension: '.mp3',
      });
    });

    it('should detect audio in nested paths', () => {
      const result = detectFileType('music/albums/track.flac');
      expect(result).toEqual({
        type: 'audio',
        mimeType: 'audio/flac',
        extension: '.flac',
      });
    });
  });

  // ==========================================================================
  // detectFileType — Unsupported / Edge cases
  // ==========================================================================

  describe('detectFileType - unsupported', () => {
    it('should return null for unsupported extensions', () => {
      expect(detectFileType('image.png')).toBeNull();
      expect(detectFileType('document.docx')).toBeNull();
      expect(detectFileType('spreadsheet.xlsx')).toBeNull();
      expect(detectFileType('video.avi')).toBeNull();
      expect(detectFileType('script.js')).toBeNull();
    });

    it('should return null for files with no extension', () => {
      expect(detectFileType('README')).toBeNull();
      expect(detectFileType('Makefile')).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(detectFileType('')).toBeNull();
    });

    it('should handle files with multiple dots', () => {
      const result = detectFileType('my.report.final.pdf');
      expect(result).toEqual({
        type: 'pdf',
        mimeType: 'application/pdf',
        extension: '.pdf',
      });
    });

    it('should handle dotfiles (hidden files) returning null', () => {
      expect(detectFileType('.gitignore')).toBeNull();
    });

    it('should handle path with spaces', () => {
      const result = detectFileType('my documents/my file.mp3');
      expect(result).toEqual({
        type: 'audio',
        mimeType: 'audio/mpeg',
        extension: '.mp3',
      });
    });

    it('should handle path with special characters', () => {
      const result = detectFileType('notes/über-report (final).pdf');
      expect(result).toEqual({
        type: 'pdf',
        mimeType: 'application/pdf',
        extension: '.pdf',
      });
    });
  });

  // ==========================================================================
  // getSupportedExtensions
  // ==========================================================================

  describe('getSupportedExtensions', () => {
    it('should return pdf extensions', () => {
      const exts = getSupportedExtensions();
      expect(exts.pdf).toEqual(['.pdf']);
    });

    it('should return all audio extensions', () => {
      const exts = getSupportedExtensions();
      expect(exts.audio).toContain('.mp3');
      expect(exts.audio).toContain('.wav');
      expect(exts.audio).toContain('.m4a');
      expect(exts.audio).toContain('.aac');
      expect(exts.audio).toContain('.ogg');
      expect(exts.audio).toContain('.opus');
      expect(exts.audio).toContain('.flac');
      expect(exts.audio).toContain('.webm');
      expect(exts.audio).toContain('.mp4');
      expect(exts.audio).toContain('.wma');
    });

    it('should return exactly 10 audio extensions', () => {
      const exts = getSupportedExtensions();
      expect(exts.audio).toHaveLength(10);
    });
  });

  // ==========================================================================
  // isSupportedFile
  // ==========================================================================

  describe('isSupportedFile', () => {
    it('should return true for PDF files', () => {
      expect(isSupportedFile('report.pdf')).toBe(true);
    });

    it('should return true for audio files', () => {
      expect(isSupportedFile('recording.mp3')).toBe(true);
      expect(isSupportedFile('audio.wav')).toBe(true);
    });

    it('should return false for unsupported files', () => {
      expect(isSupportedFile('image.png')).toBe(false);
      expect(isSupportedFile('doc.txt')).toBe(false);
    });

    it('should return false for files with no extension', () => {
      expect(isSupportedFile('noext')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isSupportedFile('')).toBe(false);
    });
  });
});
