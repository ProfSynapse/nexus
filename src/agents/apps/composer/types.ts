/**
 * Composer app type definitions.
 *
 * Located at: src/agents/apps/composer/types.ts
 * Defines the IFormatComposer strategy interface, discriminated union inputs,
 * composition options, results, and error types used by all composer services
 * and the compose tool.
 */

import { TFile, Vault } from 'obsidian';

/**
 * Strategy interface for format-specific composition.
 * Each format (text, pdf, audio) implements this interface.
 */
export interface IFormatComposer {
  /** File extensions this composer handles (lowercase, no dot). e.g. ['md', 'txt'] */
  readonly supportedExtensions: string[];

  /** Whether this composer is available on the current platform. */
  readonly isAvailableOnPlatform: boolean;

  /**
   * Compose multiple files into a single output.
   *
   * @param input - Either a flat file list (concat mode) or track list (mix mode)
   * @param vault - Obsidian Vault for file reads
   * @param options - Format-specific options
   * @returns Raw output content — string for text formats, Uint8Array for binary
   * @throws ComposerError on any failure (with failedFiles[] when applicable)
   */
  compose(input: ComposeInput, vault: Vault, options: ComposeOptions): Promise<Uint8Array | string>;
}

/**
 * Discriminated union for compose input modes.
 * Text and PDF always use 'concat'. Audio supports both.
 */
export type ComposeInput =
  | { mode: 'concat'; files: TFile[] }
  | { mode: 'mix'; tracks: TrackInput[] };

/**
 * Per-track input for audio mix mode.
 */
export interface TrackInput {
  file: TFile;
  /** Playback volume, 0.0-1.0. Default: 1.0 */
  volume: number;
  /** Start time offset in seconds. Default: 0 */
  offset: number;
  /** Fade-in duration in seconds. Default: 0 */
  fadeIn: number;
  /** Fade-out duration in seconds. Default: 0 */
  fadeOut: number;
}

/**
 * Options passed to IFormatComposer.compose().
 * Each composer reads only the fields it cares about.
 */
export interface ComposeOptions {
  /** Section separator between files. Default: '\n---\n' */
  separator?: string;
  /** Prepend each file's name as a heading. Default: false */
  includeHeaders?: boolean;
  /** Heading level for file headers. Default: 2 (## Filename) */
  headerLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /** How to handle YAML frontmatter. Default: 'first' */
  frontmatterHandling?: 'first' | 'merge' | 'strip';
  /** Audio output encoding format. Default: 'wav' */
  outputFormat?: AudioOutputFormat;
  /** Mix mode: total output duration in seconds. Default: longest track */
  duration?: number;
}

/** Supported audio output encoding formats. */
export type AudioOutputFormat = 'wav' | 'mp3' | 'webm';

/**
 * Result from the compose tool.
 */
export interface ComposeResult {
  success: true;
  /** Vault-relative path of the output file */
  path: string;
  /** Number of input files composed */
  fileCount: number;
  /** Total size of input files in bytes */
  totalInputSize: number;
  /** Size of output file in bytes */
  outputSize: number;
}

/**
 * Error class for composition failures.
 * Carries failedFiles[] for LLM self-correction.
 */
export class ComposerError extends Error {
  readonly failedFiles: string[];

  constructor(message: string, failedFiles: string[] = []) {
    super(message);
    this.name = 'ComposerError';
    this.failedFiles = failedFiles;
  }
}
