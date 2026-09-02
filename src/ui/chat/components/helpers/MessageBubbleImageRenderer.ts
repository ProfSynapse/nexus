import { App, Component, setIcon } from 'obsidian';

import { ConversationMessage } from '../../../../types/chat/ChatTypes';

interface MessageBubbleImageRendererDependencies {
  app: App;
  component: Component;
  getMessage: () => ConversationMessage;
  getElement: () => HTMLElement | null;
  getImageBubbleElement: () => HTMLElement | null;
  setImageBubbleElement: (element: HTMLElement | null) => void;
}

interface MessageBubbleImageData {
  imagePath: string;
  prompt?: string;
  dimensions?: { width: number; height: number };
  model?: string;
}

/**
 * Renders generated images as their own bubble in the message stream, above
 * the assistant's text bubble. This is the chat surface, not the tool status
 * ticker: the ticker shows what ran, this shows what came back.
 */
export class MessageBubbleImageRenderer {
  private renderedBubbles: HTMLElement[] = [];
  private renderedPaths = new Set<string>();

  constructor(private readonly deps: MessageBubbleImageRendererDependencies) {}

  renderLoadedToolResults(toolCalls: ConversationMessage['toolCalls'] | undefined, parent: HTMLElement): void {
    if (!toolCalls) {
      return;
    }

    for (const toolCall of toolCalls) {
      if (toolCall.result && toolCall.success !== false) {
        this.renderFromResult(toolCall.result, parent);
      }
    }
  }

  renderFromResult(result: unknown, parent?: HTMLElement | null): void {
    const host = parent ?? this.deps.getElement();
    if (!host) {
      return;
    }

    for (const imageData of this.extractImagesFromResult(result)) {
      if (this.renderedPaths.has(imageData.imagePath)) {
        continue;
      }
      this.renderedPaths.add(imageData.imagePath);

      const imageBubble = this.buildImageBubbleElement(imageData);
      host.appendChild(imageBubble);
      this.renderedBubbles.push(imageBubble);
      this.deps.setImageBubbleElement(imageBubble);
    }
  }

  clear(): void {
    for (const bubble of this.renderedBubbles) {
      bubble.remove();
    }
    this.renderedBubbles = [];
    this.renderedPaths.clear();

    const tracked = this.deps.getImageBubbleElement();
    if (tracked) {
      tracked.remove();
    }
    this.deps.setImageBubbleElement(null);
  }

  /**
   * A tool call's result is whatever `useTools` returned. With one command the
   * inner tool's data is spread to the top level ({ agent, tool, success,
   * imagePath }); with several it is nested as data.results[]. Both shapes,
   * plus a bare { data: { imagePath } }, yield images here.
   */
  private extractImagesFromResult(result: unknown): MessageBubbleImageData[] {
    if (!result || typeof result !== 'object') {
      return [];
    }

    const record = result as { data?: unknown; results?: unknown };
    const data = record.data;
    const batchResults = Array.isArray(record.results)
      ? record.results
      : data && typeof data === 'object' && Array.isArray((data as { results?: unknown }).results)
        ? (data as { results: unknown[] }).results
        : null;

    if (batchResults) {
      const images: MessageBubbleImageData[] = [];
      for (const entry of batchResults) {
        if (!entry || typeof entry !== 'object' || (entry as { success?: unknown }).success === false) {
          continue;
        }
        const image = this.extractSingleImage(entry);
        if (image) {
          images.push(image);
        }
      }
      return images;
    }

    const single = this.extractSingleImage(result);
    return single ? [single] : [];
  }

  private extractSingleImage(result: unknown): MessageBubbleImageData | null {
    if (!result || typeof result !== 'object') {
      return null;
    }

    const directResult = result as { data?: unknown; imagePath?: unknown };
    const data = typeof directResult.imagePath === 'string' ? result : (directResult.data ?? result);

    if (data && typeof data === 'object' && typeof (data as { imagePath?: unknown }).imagePath === 'string') {
      const typedData = data as {
        imagePath: string;
        prompt?: unknown;
        revisedPrompt?: unknown;
        dimensions?: { width: number; height: number };
        model?: unknown;
      };

      return {
        imagePath: typedData.imagePath,
        prompt: (typedData.prompt as string | undefined) || (typedData.revisedPrompt as string | undefined),
        dimensions: typedData.dimensions,
        model: typedData.model as string | undefined
      };
    }

    return null;
  }

  private buildImageBubbleElement(imageData: MessageBubbleImageData): HTMLElement {
    const imageBubble = createDiv();
    imageBubble.addClass('message-container');
    imageBubble.addClass('message-image');
    imageBubble.setAttribute('data-message-id', `${this.deps.getMessage().id}_image`);

    const bubble = imageBubble.createDiv('message-bubble image-bubble');
    const imageContainer = bubble.createDiv('generated-image-container');
    const img = imageContainer.createEl('img', { cls: 'generated-image' });

    const resourcePath = this.deps.app.vault.adapter.getResourcePath(imageData.imagePath);
    img.src = resourcePath;
    img.alt = imageData.prompt || 'Generated image';
    img.setAttribute('loading', 'lazy');

    const openButton = bubble.createEl('button', { cls: 'generated-image-open-btn' });
    setIcon(openButton, 'external-link');
    openButton.createSpan({ text: 'Open in Obsidian' });
    this.deps.component.registerDomEvent(openButton, 'click', () => {
      void this.deps.app.workspace.openLinkText(imageData.imagePath, '', false);
    });

    return imageBubble;
  }
}
