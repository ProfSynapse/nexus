import { TFile, Vault } from 'obsidian';

export interface ReferenceImageData {
  data: string;
  mimeType: string;
}

export function getImageMimeType(path: string): string {
  const ext = path.toLowerCase().split('.').pop() || '';
  const mimeTypes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
  };
  return mimeTypes[ext] || 'image/png';
}

export async function loadReferenceImage(vault: Vault, path: string): Promise<ReferenceImageData> {
  const file = vault.getAbstractFileByPath(path);
  if (!file) {
    throw new Error(`Reference image not found: ${path}`);
  }

  if (!(file instanceof TFile)) {
    throw new Error(`Reference image path is not a file: ${path}`);
  }

  const data = await vault.readBinary(file);
  return {
    data: arrayBufferToBase64(data),
    mimeType: getImageMimeType(path),
  };
}

export function arrayBufferToBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = '';
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...Array.from(chunk));
  }

  return btoa(binary);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function getByPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

/** The error a video job throws when its caller aborts it. */
export class VideoGenerationAbortedError extends Error {
  constructor(message = 'Video generation was cancelled.') {
    super(message);
    this.name = 'VideoGenerationAbortedError';
  }
}

/**
 * Wait `ms`, or reject with VideoGenerationAbortedError as soon as `signal`
 * aborts. Whichever happens first removes the other: the timer is cleared on
 * abort and the abort listener is removed when the timer fires, so a finished
 * or cancelled wait leaves nothing scheduled behind it.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new VideoGenerationAbortedError());
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      window.clearTimeout(timer);
      reject(new VideoGenerationAbortedError());
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
