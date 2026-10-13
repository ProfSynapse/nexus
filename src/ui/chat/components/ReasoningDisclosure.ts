import { Component, setIcon } from 'obsidian';
import type { ReasoningDisplayState } from '../../../services/chat/ChatTurnStore';
import { ThinkingLoader } from './ThinkingLoader';
import { ReasoningScrollController } from '../controllers/ReasoningScrollController';

/** One stable native accordion per generation. No tool/runtime state lives here. */
export class ReasoningDisclosure extends Component {
  readonly element: HTMLDetailsElement;
  private summary: HTMLElement;
  private body: HTMLElement;
  private loader: ThinkingLoader;
  private scroll: ReasoningScrollController;
  private text = '';
  private textNode?: Text;
  private generationId?: string;
  private detachedScrollTop?: number;
  prepareDetach(): void { this.detachedScrollTop = this.body.scrollTop; }
  restorePosition(): void {
    if (this.detachedScrollTop !== undefined) {
      this.scroll.restorePosition(this.detachedScrollTop);
      this.detachedScrollTop = undefined;
    }
  }
  constructor(parent: HTMLElement, onHold: (hold: boolean) => void) {
    super();
    this.element = parent.createEl('details', { cls: 'message-reasoning' });
    this.element.open = false;
    this.element.setAttribute('data-reasoning-index', '0');
    this.summary = this.element.createEl('summary', { cls: 'message-reasoning-summary' });
    this.loader = this.addChild(new ThinkingLoader());
    this.loader.start(this.summary);
    const chevron = this.summary.createSpan({ cls: 'reasoning-chevron', attr: { 'aria-hidden': 'true' } });
    setIcon(chevron, 'chevron-right');
    const panel = this.element.createDiv('reasoning-panel');
    this.body = panel.createDiv('message-reasoning-content');
    this.body.setAttribute('tabindex', '0');
    this.body.setAttribute('aria-label', 'Reasoning');
    const button = panel.createEl('button', { cls: 'reasoning-catch-up clickable-icon', attr: { 'aria-label': 'Jump to latest reasoning', title: 'Jump to latest reasoning' } });
    setIcon(button, 'arrow-down');
    button.hidden = true;
    this.scroll = this.addChild(new ReasoningScrollController(this.body, button, () => this.element.open && !this.element.hidden, onHold));
    this.registerDomEvent(this.element, 'toggle', () => {
      this.summary.setAttribute('aria-expanded', String(this.element.open));
      this.scroll.afterGrowth();
    });
  }
  attach(parent: HTMLElement): void {
    if (this.element.parentElement !== parent) parent.appendChild(this.element);
    this.restorePosition();
    this.scroll.afterGrowth();
  }
  update(state: ReasoningDisplayState): void {
    if (state.generationId && state.generationId !== this.generationId) {
      this.element.open = false;
      this.generationId = state.generationId;
      this.scroll.catchUp();
    }
    const active = state.phase === 'waiting' || state.phase === 'thinking';
    this.loader.setActive(active);
    this.summary.setAttribute('aria-label', active ? 'Thinking' : 'Reasoning');
    this.summary.setAttribute('aria-expanded', String(this.element.open));
    this.element.hidden = !active && !state.text.trim();
    const next = state.text || (active ? 'Waiting for reasoning…' : '');
    this.scroll.beforeGrowth();
    if (next !== this.text) {
      if (this.textNode && next.startsWith(this.text)) this.textNode.appendData(next.slice(this.text.length));
      else {
        this.body.textContent = next;
        this.textNode = this.body.firstChild?.nodeType === 3 ? this.body.firstChild as Text : undefined;
      }
      this.text = next;
    }
    this.scroll.afterGrowth();
  }
  onunload(): void { this.element.remove(); }
}
