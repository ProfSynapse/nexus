import { percentageToState } from '../constants/ContextThresholds';

export class ContextBadge {
  private badgeEl: HTMLElement;
  private percentage = 0;

  constructor(container: HTMLElement) {
    this.badgeEl = container.createEl('div', {
      cls: 'context-badge context-badge-safe',
    });
    this.badgeEl.setAttribute('role', 'status');
    this.badgeEl.setAttribute('aria-live', 'polite');
    this.badgeEl.setAttribute('aria-label', 'Context usage: 0%, safe');
    this.badgeEl.textContent = '0%';
  }

  public setPercentage(percentage: number): void {
    this.percentage = Math.min(100, Math.max(0, percentage));
    const severity = percentageToState(this.percentage);
    const rounded = Math.round(this.percentage);
    this.badgeEl.className = `context-badge context-badge-${severity}`;
    this.badgeEl.textContent = `${rounded}%`;
    this.badgeEl.setAttribute('aria-label', `Context usage: ${rounded}%, ${severity}`);
  }

  public cleanup(): void {
    if (this.badgeEl && this.badgeEl.parentElement) {
      this.badgeEl.parentElement.removeChild(this.badgeEl);
    }
  }
}
