import { Component, setIcon } from 'obsidian';
import { ICON_SUBSTITUTIONS, THINKING_WORDS } from '../constants/thinkingWords';

export class ThinkingLoader extends Component {
  private container: HTMLElement | null = null;
  private wordElement: HTMLElement | null = null;
  private iconElement: HTMLElement | null = null;
  private currentWordIndex = Math.floor(Math.random() * THINKING_WORDS.length);
  private typewriterInterval: number | null = null;
  private cycleInterval: number | null = null;
  public isDisposed = false;

  public start(parent: HTMLElement): void {
    if (this.isDisposed) return;
    this.stop();

    this.container = parent.createDiv('thinking-loader');
    this.iconElement = this.container.createDiv('thinking-loader-icon');
    this.wordElement = this.container.createDiv('thinking-loader-text');

    this.startCycle();
  }

  public stop(): void {
    if (this.typewriterInterval) {
      clearInterval(this.typewriterInterval);
      this.typewriterInterval = null;
    }
    if (this.cycleInterval) {
      clearInterval(this.cycleInterval);
      this.cycleInterval = null;
    }
    this.container?.remove();
    this.container = null;
  }

  onunload(): void {
    this.stop();
    this.isDisposed = true;
    super.onunload();
  }

  private startCycle(): void {
    this.renderCurrentWord();
    this.cycleInterval = window.setInterval(() => {
      if (this.isDisposed) {
        this.stop();
        return;
      }
      let next: number;
      do {
        next = Math.floor(Math.random() * THINKING_WORDS.length);
      } while (next === this.currentWordIndex && THINKING_WORDS.length > 1);
      this.currentWordIndex = next;
      this.renderCurrentWord();
    }, 2500);
    this.registerInterval(this.cycleInterval);
  }

  private renderCurrentWord(): void {
    if (!this.wordElement || this.isDisposed) return;

    if (this.typewriterInterval) {
      clearInterval(this.typewriterInterval);
      this.typewriterInterval = null;
    }

    const entry = THINKING_WORDS[this.currentWordIndex];
    const text = entry.word;
    this.updateIcon(entry.icon);
    this.wordElement.textContent = '';
    let charIndex = 0;

    this.typewriterInterval = window.setInterval(() => {
      if (this.isDisposed || !this.wordElement) {
        if (this.typewriterInterval) clearInterval(this.typewriterInterval);
        return;
      }

      if (charIndex < text.length) {
        this.wordElement.textContent += text.charAt(charIndex);
        charIndex += 1;
        return;
      }

      if (this.typewriterInterval) {
        clearInterval(this.typewriterInterval);
        this.typewriterInterval = null;
      }

      let dotsCount = 0;
      this.typewriterInterval = window.setInterval(() => {
        if (this.isDisposed || !this.wordElement) {
          if (this.typewriterInterval) clearInterval(this.typewriterInterval);
          return;
        }
        dotsCount = (dotsCount + 1) % 4;
        this.wordElement.textContent = text + '.'.repeat(dotsCount);
      }, 300);
      this.registerInterval(this.typewriterInterval);
    }, 90);

    this.registerInterval(this.typewriterInterval);
  }

  private updateIcon(iconName: string): void {
    if (!this.iconElement || this.isDisposed) return;

    const finalIconName = ICON_SUBSTITUTIONS[iconName] || iconName;
    this.iconElement.empty();
    try {
      setIcon(this.iconElement, finalIconName);
    } catch {
      try {
        setIcon(this.iconElement, 'sparkles');
      } catch {
        // ignore icon fallback failures
      }
    }
  }
}
