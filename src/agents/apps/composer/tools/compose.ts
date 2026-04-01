/**
 * ComposeTool — Main composition tool for the Composer agent.
 *
 * Located at: src/agents/apps/composer/tools/compose.ts
 * Validates parameters, resolves files via FileReader, routes to the
 * appropriate IFormatComposer (Text, PDF, or Audio), and writes the
 * output to vault. Supports concat mode (all formats) and mix mode (audio).
 *
 * Used by: ComposerAgent, exposed via MCP getTools/useTools.
 */

import { BaseTool } from '../../../baseTool';
import { BaseAppAgent } from '../../BaseAppAgent';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { normalizePath, TFolder } from 'obsidian';
import { isValidPath } from '../../../../utils/pathUtils';
import {
  ComposeInput,
  ComposeOptions,
  ComposerError,
} from '../types';
import { FileReader } from '../services/FileReader';
import { TextComposer } from '../services/TextComposer';
import { PdfComposer } from '../services/PdfComposer';
import { AudioComposer } from '../services/AudioComposer';
import { IFormatComposer } from '../types';

interface ComposeParams extends CommonParameters {
  files?: string[];
  format: 'markdown' | 'pdf' | 'audio';
  outputPath: string;
  separator?: string;
  includeHeaders?: boolean;
  headerLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  frontmatterHandling?: 'first' | 'merge' | 'strip';
  maxFileSizeMb?: number;
  maxTotalSizeMb?: number;
  audioMode?: 'concat' | 'mix';
  tracks?: Array<{
    file: string;
    volume?: number;
    offset?: number;
    fadeIn?: number;
    fadeOut?: number;
  }>;
  outputFormat?: 'wav' | 'mp3' | 'webm';
  duration?: number;
  overwrite?: boolean;
}

const COMPOSE_TIMEOUT_MS = 30_000;

export class ComposeTool extends BaseTool<ComposeParams, CommonResult> {
  private agent: BaseAppAgent;

  constructor(agent: BaseAppAgent) {
    super(
      'compose',
      'Compose Files',
      'Merge multiple vault files of the same type into a single output. ' +
      'Supports markdown (.md), PDF (.pdf), and audio (.mp3, .wav, .ogg, .webm). ' +
      'Audio supports concat (sequential) and mix (layered tracks with volume/fade) modes. ' +
      'Note: WebM audio encoding runs at real-time speed (encoding time equals audio duration).',
      '1.0.0'
    );
    this.agent = agent;
  }

  async execute(params: ComposeParams): Promise<CommonResult> {
    const vault = this.agent.getVault();
    if (!vault) {
      return this.prepareResult(false, undefined,
        'Vault not available — cannot compose files.');
    }

    const { format, outputPath, audioMode, tracks, files, overwrite } = params;

    // --- 1. Parameter validation ---

    if (!isValidPath(outputPath)) {
      return this.prepareResult(false, undefined,
        `Invalid output path: "${outputPath}" — must be vault-relative, no ".." or absolute paths`);
    }

    const isAudioMix = format === 'audio' && audioMode === 'mix';
    const validatedTracks = isAudioMix ? tracks : undefined;
    const validatedFiles = isAudioMix ? undefined : files;

    if (isAudioMix) {
      if (!tracks || tracks.length === 0) {
        return this.prepareResult(false, undefined,
          'Audio mix mode requires "tracks" array with at least one track');
      }
      for (const track of tracks) {
        if (!track.file || !isValidPath(track.file)) {
          return this.prepareResult(false, undefined,
            `Invalid track file path: "${track.file}"`);
        }
        if (track.volume !== undefined && (track.volume < 0 || track.volume > 1)) {
          return this.prepareResult(false, undefined,
            `Track volume must be 0.0-1.0, got ${track.volume} for "${track.file}"`);
        }
        if (track.offset !== undefined && track.offset < 0) {
          return this.prepareResult(false, undefined,
            `Track offset must be >= 0, got ${track.offset} for "${track.file}"`);
        }
        if (track.fadeIn !== undefined && track.fadeIn < 0) {
          return this.prepareResult(false, undefined,
            `Track fadeIn must be >= 0, got ${track.fadeIn} for "${track.file}"`);
        }
        if (track.fadeOut !== undefined && track.fadeOut < 0) {
          return this.prepareResult(false, undefined,
            `Track fadeOut must be >= 0, got ${track.fadeOut} for "${track.file}"`);
        }
      }
    } else {
      if (!files || files.length === 0) {
        return this.prepareResult(false, undefined,
          'At least one file path is required in "files" array');
      }
      const invalidPaths = files.filter(f => !isValidPath(f));
      if (invalidPaths.length > 0) {
        return this.prepareResult(false, undefined,
          `Invalid file path(s): ${invalidPaths.map(p => `"${p}"`).join(', ')} — must be vault-relative, no ".." or absolute paths`);
      }
    }

    // --- 2. Output conflict check ---
    const normalizedOutput = normalizePath(outputPath);
    const existingFile = vault.getAbstractFileByPath(normalizedOutput);
    if (existingFile && !overwrite) {
      return this.prepareResult(false, undefined,
        `File already exists at ${normalizedOutput}. Set overwrite: true to replace.`);
    }

    // --- 3. Select composer (lazy — only instantiate the one needed) ---
    let composer: IFormatComposer;
    switch (format) {
      case 'markdown':
        composer = new TextComposer();
        break;
      case 'pdf':
        composer = new PdfComposer();
        break;
      case 'audio':
        composer = new AudioComposer();
        break;
      default:
        return this.prepareResult(false, undefined,
          `Unsupported format: "${String(format)}". Use listFormats to see supported formats.`);
    }

    if (!composer.isAvailableOnPlatform) {
      return this.prepareResult(false, undefined,
        `Format "${format}" is not available on this platform. Audio requires desktop (Electron).`);
    }

    // --- 4. Resolve files ---
    const reader = new FileReader(vault, params.maxFileSizeMb ?? 50);
    let input: ComposeInput;

    try {
      if (isAudioMix) {
        if (!validatedTracks) {
          return this.prepareResult(false, undefined,
            'Audio mix mode requires "tracks" array with at least one track');
        }

        const trackPaths = validatedTracks.map(t => t.file);
        const resolvedFiles = reader.resolveFiles(trackPaths);

        input = {
          mode: 'mix',
          tracks: validatedTracks.map((t, i) => ({
            file: resolvedFiles[i],
            volume: t.volume ?? 1.0,
            offset: t.offset ?? 0,
            fadeIn: t.fadeIn ?? 0,
            fadeOut: t.fadeOut ?? 0,
          })),
        };
      } else {
        if (!validatedFiles) {
          return this.prepareResult(false, undefined,
            'At least one file path is required in "files" array');
        }

        const resolvedFiles = reader.resolveFiles(validatedFiles);
        input = { mode: 'concat', files: resolvedFiles };
      }
    } catch (err) {
      if (err instanceof ComposerError) {
        const msg = err.failedFiles.length > 0
          ? `${err.message} [failedFiles: ${err.failedFiles.join(', ')}]`
          : err.message;
        return this.prepareResult(false, undefined, msg);
      }
      throw err;
    }

    // --- 5. Compute total input size + aggregate limit ---
    const allFiles = input.mode === 'concat'
      ? input.files
      : input.tracks.map(t => t.file);
    const totalInputSize = allFiles.reduce((sum, f) => sum + f.stat.size, 0);

    const maxTotalBytes = (params.maxTotalSizeMb ?? 200) * 1024 * 1024;
    if (totalInputSize > maxTotalBytes) {
      return this.prepareResult(false, undefined,
        `Total input size (${(totalInputSize / 1024 / 1024).toFixed(1)}MB) exceeds limit of ${params.maxTotalSizeMb ?? 200}MB`);
    }

    // --- 6. Compose with timeout ---
    const options: ComposeOptions = {
      separator: params.separator,
      includeHeaders: params.includeHeaders,
      headerLevel: params.headerLevel,
      frontmatterHandling: params.frontmatterHandling,
      outputFormat: params.outputFormat,
      duration: params.duration,
    };

    let output: Uint8Array | string;
    try {
      output = await Promise.race([
        composer.compose(input, vault, options),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new ComposerError('Composition timed out after 30 seconds')), COMPOSE_TIMEOUT_MS)
        ),
      ]);
    } catch (err) {
      if (err instanceof ComposerError) {
        const msg = err.failedFiles.length > 0
          ? `${err.message} [failedFiles: ${err.failedFiles.join(', ')}]`
          : err.message;
        return this.prepareResult(false, undefined, msg);
      }
      return this.prepareResult(false, undefined,
        `Composition failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // --- 7. Write output ---
    const dir = normalizedOutput.substring(0, normalizedOutput.lastIndexOf('/'));
    if (dir && !vault.getAbstractFileByPath(dir)) {
      try {
        await vault.createFolder(dir);
      } catch {
        // Folder may already exist due to race condition
        if (!(vault.getAbstractFileByPath(dir) instanceof TFolder)) {
          return this.prepareResult(false, undefined,
            `Failed to create output directory: ${dir}`);
        }
      }
    }

    let outputSize: number;
    try {
      const existingOutput = existingFile;
      if (existingOutput) {
        // Safe overwrite: write to temp path first, delete old, then rename
        const tempPath = normalizedOutput + '.composing';
        const app = this.agent.getApp();
        if (!app) {
          return this.prepareResult(false, undefined, 'Obsidian app is not available');
        }
        if (typeof output === 'string') {
          await vault.create(tempPath, output);
          outputSize = new TextEncoder().encode(output).byteLength;
        } else {
          const arrayBuffer = toArrayBuffer(output);
          await vault.createBinary(tempPath, arrayBuffer);
          outputSize = output.byteLength;
        }
        await app.fileManager.trashFile(existingOutput);
        const tempFile = vault.getAbstractFileByPath(tempPath);
        if (tempFile) {
          await vault.rename(tempFile, normalizedOutput);
        }
      } else {
        if (typeof output === 'string') {
          await vault.create(normalizedOutput, output);
          outputSize = new TextEncoder().encode(output).byteLength;
        } else {
          const arrayBuffer = toArrayBuffer(output);
          await vault.createBinary(normalizedOutput, arrayBuffer);
          outputSize = output.byteLength;
        }
      }
    } catch (err) {
      return this.prepareResult(false, undefined,
        `Failed to write output file: ${err instanceof Error ? err.message : String(err)}`);
    }

    // --- 8. Return result ---
    return this.prepareResult(true, {
      path: normalizedOutput,
      fileCount: allFiles.length,
      totalInputSize,
      outputSize,
    });
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Vault-relative paths of files to compose. All files must be the same type. Required for concat mode (default).',
        },
        format: {
          type: 'string',
          enum: ['markdown', 'pdf', 'audio'],
          description: 'Output format. Determines which composer handles the operation.',
        },
        outputPath: {
          type: 'string',
          description: 'Vault-relative path for the output file. Parent directories are created automatically.',
        },
        separator: {
          type: 'string',
          description: 'Markdown only: separator between file sections. Default: "\\n---\\n"',
        },
        includeHeaders: {
          type: 'boolean',
          description: 'Markdown only: prepend each file\'s name as a heading. Default: false',
        },
        headerLevel: {
          type: 'number',
          enum: [1, 2, 3, 4, 5, 6],
          description: 'Markdown only: heading level for file headers. Default: 2',
        },
        frontmatterHandling: {
          type: 'string',
          enum: ['first', 'merge', 'strip'],
          description: 'Markdown only: how to handle YAML frontmatter. "first" keeps only the first file\'s frontmatter. "merge" shallow-merges all. "strip" removes all. Default: "first"',
        },
        maxFileSizeMb: {
          type: 'number',
          description: 'Per-file size limit in MB. Default: 50',
        },
        maxTotalSizeMb: {
          type: 'number',
          description: 'Aggregate size limit for all input files in MB. Default: 200',
        },
        audioMode: {
          type: 'string',
          enum: ['concat', 'mix'],
          description: 'Audio only: "concat" joins files sequentially. "mix" layers tracks with individual volume/offset/fade. Default: "concat"',
        },
        tracks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string', description: 'Vault-relative path to audio file' },
              volume: { type: 'number', description: 'Playback volume, 0.0-1.0. Default: 1.0' },
              offset: { type: 'number', description: 'Start time offset in seconds. Default: 0' },
              fadeIn: { type: 'number', description: 'Fade-in duration in seconds. Default: 0' },
              fadeOut: { type: 'number', description: 'Fade-out duration in seconds. Default: 0' },
            },
            required: ['file'],
          },
          description: 'Audio mix mode only: track definitions with per-track volume, offset, and fade controls.',
        },
        outputFormat: {
          type: 'string',
          enum: ['wav', 'mp3', 'webm'],
          description: 'Audio only: output encoding format. Default: "wav"',
        },
        duration: {
          type: 'number',
          description: 'Audio only: total output duration in seconds. Trims if shorter than composed audio. Default: full duration.',
        },
        overwrite: {
          type: 'boolean',
          description: 'If true, overwrite existing file at outputPath. Default: false',
        },
      },
      required: ['format', 'outputPath'],
    });
  }
}

/**
 * Convert a Uint8Array to an ArrayBuffer safely.
 * Handles sub-views where buffer.byteLength !== view.byteLength,
 * and ensures the result is an ArrayBuffer (not SharedArrayBuffer).
 */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      && data.buffer instanceof ArrayBuffer) {
    return data.buffer;
  }
  // Copy into a fresh ArrayBuffer to handle sub-views and SharedArrayBuffer
  const copy = new ArrayBuffer(data.byteLength);
  new Uint8Array(copy).set(data);
  return copy;
}
