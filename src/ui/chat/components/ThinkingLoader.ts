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
  private active = true;
  private ownerWindow: Window = window;

  public start(parent: HTMLElement): void {
    if (this.isDisposed) return;
    this.stop();

    this.ownerWindow = parent.ownerDocument?.defaultView ?? window;
    this.active = true;
    this.container = parent.createDiv('thinking-loader');
    this.container.setAttribute('aria-hidden', 'true');
    this.iconElement = this.container.createDiv('thinking-loader-icon');
    this.wordElement = this.container.createDiv('thinking-loader-text');

    this.startCycle();
  }

  public stop(): void {
    if (this.typewriterInterval) {
      this.ownerWindow.clearInterval(this.typewriterInterval);
      this.typewriterInterval = null;
    }
    if (this.cycleInterval) {
      this.ownerWindow.clearInterval(this.cycleInterval);
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
    this.cycleInterval = this.ownerWindow.setInterval(() => {
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
    }, 5000);
    this.registerInterval(this.cycleInterval);
  }

  private prefersReducedMotion(): boolean {
    try {
      return this.ownerWindow.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
    } catch {
      return false;
    }
  }

  private renderCurrentWord(): void {
    if (!this.wordElement || this.isDisposed) return;

    if (this.typewriterInterval) {
      this.ownerWindow.clearInterval(this.typewriterInterval);
      this.typewriterInterval = null;
    }

    const entry = THINKING_WORDS[this.currentWordIndex];
    const text = entry.word;
    this.updateIcon(entry.icon);

    if (this.prefersReducedMotion()) {
      this.wordElement.textContent = text + '...';
      return;
    }

    this.wordElement.textContent = '';
    let charIndex = 0;

    this.typewriterInterval = this.ownerWindow.setInterval(() => {
      if (this.isDisposed || !this.active || !this.wordElement) {
        if (this.typewriterInterval) this.ownerWindow.clearInterval(this.typewriterInterval);
        return;
      }

      if (charIndex < text.length) {
        this.wordElement.textContent += text.charAt(charIndex);
        charIndex += 1;
        return;
      }

      if (this.typewriterInterval) {
        this.ownerWindow.clearInterval(this.typewriterInterval);
        this.typewriterInterval = null;
      }

      let dotsCount = 0;
      this.typewriterInterval = this.ownerWindow.setInterval(() => {
        if (this.isDisposed || !this.active || !this.wordElement) {
          if (this.typewriterInterval) this.ownerWindow.clearInterval(this.typewriterInterval);
          return;
        }
        dotsCount = (dotsCount + 1) % 4;
        this.wordElement.textContent = text + '.'.repeat(dotsCount);
      }, 500);
      this.registerInterval(this.typewriterInterval);
    }, 180);

    this.registerInterval(this.typewriterInterval);
  }

  public setActive(active: boolean): void {
    if (this.active === active || !this.container) return;
    this.active = active;
    this.container.toggleClass('is-settled', !active);
    if (this.cycleInterval !== null) this.ownerWindow.clearInterval(this.cycleInterval);
    this.cycleInterval = null;
    if (this.typewriterInterval !== null) this.ownerWindow.clearInterval(this.typewriterInterval);
    this.typewriterInterval = null;
    if (active) this.startCycle();
    else {
      this.updateIcon('brain');
      if (this.wordElement) this.wordElement.textContent = 'Reasoning';
    }
  }

  private updateIcon(iconName: string): void {
    if (!this.iconElement || this.isDisposed) return;

    const finalIconName = !this.active && iconName === 'brain' ? 'brain' : ICON_SUBSTITUTIONS[iconName] || iconName;
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
