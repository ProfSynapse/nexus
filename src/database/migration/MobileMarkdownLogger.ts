import { App, Platform, normalizePath } from 'obsidian';

const MAX_LOG_LINES = 500;
let writeQueue: Promise<void> = Promise.resolve();

function getParentPath(path: string): string {
  const normalized = normalizePath(path);
  const lastSlashIndex = normalized.lastIndexOf('/');
  return lastSlashIndex === -1 ? '' : normalized.slice(0, lastSlashIndex);
}

async function ensureDirectory(app: App, path: string): Promise<void> {
  if (!path) return;

  const normalized = normalizePath(path);
  const segments = normalized.split('/').filter(Boolean);
  let currentPath = '';

  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    if (!(await app.vault.adapter.exists(currentPath))) {
      await app.vault.adapter.mkdir(currentPath);
    }
  }
}

function formatDetails(details?: unknown): string {
  if (details === undefined) {
    return '';
  }

  try {
    return `\n  \`\`\`json\n${JSON.stringify(details, null, 2)}\n  \`\`\``;
  } catch {
    if (details instanceof Error) {
      return `\n  \`${details.message}\``;
    }
    return '\n  `Unable to serialize details.`';
  }
}

export function appendMobileMarkdownLog(
  app: App,
  logPath: string | undefined,
  message: string,
  details?: unknown
): void {
  if (!Platform.isMobile || !logPath) {
    return;
  }

  writeQueue = writeQueue.then(async () => {
    const normalizedPath = normalizePath(logPath);
    const parentPath = getParentPath(normalizedPath);
    await ensureDirectory(app, parentPath);

    const existing = await app.vault.adapter.exists(normalizedPath)
      ? await app.vault.adapter.read(normalizedPath)
      : '# Mobile sync trace\n\n';

    const timestamp = new Date().toISOString();
    const nextEntry = `- ${timestamp} \`${message}\`${formatDetails(details)}\n`;
    const existingLines = existing.trimEnd().split('\n');
    const preservedHeader = existingLines[0]?.startsWith('# ') ? existingLines[0] : '# Mobile sync trace';
    const bodyLines = existingLines.slice(1).filter(line => line.trim().length > 0);
    const nextLines = [preservedHeader, '', ...bodyLines, nextEntry.trimEnd()].slice(-(MAX_LOG_LINES + 2));

    await app.vault.adapter.write(normalizedPath, `${nextLines.join('\n')}\n`);
  }).catch(() => {
    // Never let debug logging break runtime behavior.
  });
}
