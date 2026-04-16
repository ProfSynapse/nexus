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

export class MessageBubbleImageRenderer {
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
    const imageData = this.extractImageFromResult(result);
    if (!imageData) {
      return;
    }

    const imageBubble = this.buildImageBubbleElement(imageData);

    if (parent) {
      parent.appendChild(imageBubble);
      this.deps.setImageBubbleElement(imageBubble);
      return;
    }

    const hostElement = this.deps.getElement();
    if (!hostElement) {
      return;
    }

    hostElement.appendChild(imageBubble);

    this.deps.setImageBubbleElement(imageBubble);
  }

  clear(): void {
    const imageBubble = this.deps.getImageBubbleElement();
    if (!imageBubble) {
      return;
    }

    imageBubble.remove();
    this.deps.setImageBubbleElement(null);
  }

  private extractImageFromResult(result: unknown): MessageBubbleImageData | null {
    if (!result || typeof result !== 'object') {
      return null;
    }

    const directResult = result as { data?: unknown };
    const data = directResult.data ?? result;

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
    const imageBubble = document.createElement('div');
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
