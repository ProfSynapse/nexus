import { App, normalizePath, TFile, TFolder, Vault, View, WorkspaceLeaf } from 'obsidian';
import { sanitizeName } from '../../../../utils/pathUtils';

export type WebViewerOpenMode = 'tab' | 'split' | 'window' | 'current';

interface WebViewerState extends Record<string, unknown> {
  url?: string;
  title?: string;
  navigate?: boolean;
  mode?: string;
}

interface WebViewerWebContents {
  isLoading?(): boolean;
  capturePage?(): Promise<NativeImageLike>;
  printToPDF?(options?: Record<string, unknown>): Promise<ArrayBuffer | SharedArrayBuffer | Uint8Array>;
  executeJavaScript?<T>(code: string): Promise<T>;
}

interface NativeImageLike {
  toPNG(): Uint8Array | ArrayBuffer;
}

interface WebViewerLikeView extends View {
  getState(): WebViewerState;
  webview?: WebViewerWebContents;
}

export const WEB_VIEWER_VIEW_TYPE = 'webviewer';
export const WEB_VIEWER_SAVE_COMMAND_ID = 'webviewer:save-to-vault';

export function getLeafForMode(app: App, mode: WebViewerOpenMode): WorkspaceLeaf {
  switch (mode) {
    case 'tab':
      return app.workspace.getLeaf('tab');
    case 'split':
      return app.workspace.getLeaf('split');
    case 'window':
      return app.workspace.getLeaf('window');
    case 'current':
    default:
      return app.workspace.getLeaf(false);
  }
}

export function getWebViewerLeaf(app: App): WorkspaceLeaf | null {
  const recentLeaf = app.workspace.getMostRecentLeaf();
  if (recentLeaf?.view.getViewType() === WEB_VIEWER_VIEW_TYPE) {
    return recentLeaf;
  }

  return app.workspace.getLeavesOfType(WEB_VIEWER_VIEW_TYPE)[0] ?? null;
}

export async function openWebViewerUrl(
  app: App,
  url: string,
  mode: WebViewerOpenMode,
  focus: boolean
): Promise<WorkspaceLeaf> {
  const leaf = getLeafForMode(app, mode);

  await leaf.setViewState({
    type: WEB_VIEWER_VIEW_TYPE,
    active: focus,
    state: {
      url,
      title: url,
      navigate: true,
    },
  });

  await app.workspace.revealLeaf(leaf);
  if (focus) {
    app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  return leaf;
}

export async function waitForWebViewerReady(
  leaf: WorkspaceLeaf,
  timeoutMs: number,
  settleMs: number
): Promise<WebViewerWebContents | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const view = leaf.view as WebViewerLikeView;
    const contents = view.webview;

    if (contents?.executeJavaScript) {
      try {
        const snapshot = await contents.executeJavaScript<{
          href?: string;
          readyState?: string;
        }>("({ href: location.href, readyState: document.readyState })");

        if (
          snapshot?.href &&
          snapshot.href !== 'about:blank' &&
          (snapshot.readyState === 'interactive' || snapshot.readyState === 'complete')
        ) {
          await sleep(settleMs);
          return contents;
        }
      } catch {
        // The WebView is present but not dom-ready yet.
      }
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for Web Viewer to load after ${timeoutMs}ms`);
}

export function getWebViewerState(leaf: WorkspaceLeaf): WebViewerState | null {
  if (leaf.view.getViewType() !== WEB_VIEWER_VIEW_TYPE) {
    return null;
  }

  const view = leaf.view as WebViewerLikeView;
  return view.getState?.() ?? null;
}

export function getWebViewerContents(leaf: WorkspaceLeaf): WebViewerWebContents | null {
  if (leaf.view.getViewType() !== WEB_VIEWER_VIEW_TYPE) {
    return null;
  }

  const view = leaf.view as WebViewerLikeView;
  return view.webview ?? null;
}

export async function ensureParentFolderExists(vault: Vault, path: string): Promise<void> {
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash === -1) {
    return;
  }

  const parentPath = path.slice(0, lastSlash);
  if (!parentPath || vault.getAbstractFileByPath(parentPath)) {
    return;
  }

  try {
    await vault.createFolder(parentPath);
  } catch {
    if (!(vault.getAbstractFileByPath(parentPath) instanceof TFolder)) {
      throw new Error(`Failed to create directory: ${parentPath}`);
    }
  }
}

export function findCreatedMarkdownFile(
  vault: Vault,
  beforePaths: Set<string>,
  startTimeMs: number
): TFile | null {
  const candidates = vault.getMarkdownFiles()
    .filter((file) => !beforePaths.has(file.path) && file.stat.mtime >= startTimeMs - 5000)
    .sort((a, b) => b.stat.mtime - a.stat.mtime);

  return candidates[0] ?? null;
}

export function resolveUniqueMarkdownPath(vault: Vault, outputPath: string): string {
  return resolveUniqueFilePath(vault, outputPath, 'md');
}

export function resolveUniqueFilePath(vault: Vault, outputPath: string, extension: string): string {
  const normalized = normalizePath(outputPath);
  const suffix = `.${extension}`;
  const withoutExtension = normalized.endsWith(suffix)
    ? normalized.slice(0, -suffix.length)
    : normalized;
  const basePath = `${withoutExtension}.${extension}`;

  if (!vault.getAbstractFileByPath(basePath)) {
    return basePath;
  }

  let counter = 1;
  let candidate = `${withoutExtension} ${counter}.${extension}`;
  while (vault.getAbstractFileByPath(candidate)) {
    counter += 1;
    candidate = `${withoutExtension} ${counter}.${extension}`;
  }

  return candidate;
}

export function hasWebViewerSaveCommand(app: App): boolean {
  return Boolean(app.commands.commands[WEB_VIEWER_SAVE_COMMAND_ID]);
}

export function buildDefaultWebCapturePath(
  vault: Vault,
  title: string | undefined,
  extension: string,
  folder = 'web-captures'
): string {
  const safeTitle = sanitizeName(title || 'web-capture');
  return resolveUniqueFilePath(vault, `${normalizePath(folder)}/${safeTitle}`, extension);
}

export function toArrayBuffer(data: ArrayBuffer | SharedArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) {
    return data;
  }

  const source = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new Uint8Array(source.byteLength);
  view.set(source);
  return view.buffer;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
