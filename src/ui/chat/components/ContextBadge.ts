import type { Component } from 'obsidian';
import { percentageToState } from '../constants/ContextThresholds';

export class ContextBadge {
  private badgeEl: HTMLElement;
  private percentage = 0;

  constructor(container: HTMLElement, _component?: Component) {
    this.badgeEl = container.createEl('div', {
      cls: 'context-badge context-badge-safe',
    });
    this.badgeEl.textContent = '0%';
  }

  public setPercentage(percentage: number): void {
    this.percentage = Math.min(100, Math.max(0, percentage));
    const severity = percentageToState(this.percentage);
    this.badgeEl.className = `context-badge context-badge-${severity}`;
    this.badgeEl.textContent = `${Math.round(this.percentage)}%`;
  }

  public cleanup(): void {
    if (this.badgeEl && this.badgeEl.parentElement) {
      this.badgeEl.parentElement.removeChild(this.badgeEl);
    }
  }
}
