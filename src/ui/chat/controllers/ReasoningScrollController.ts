import { Component } from 'obsidian';

/** Local reading intent, independent of the outer transcript's follow state. */
export class ReasoningScrollController extends Component {
  private following = true;
  private lastTop = 0;
  private frame: number | null = null;
  private observer?: ResizeObserver;
  private win: Window;
  constructor(private viewport: HTMLElement, private button: HTMLButtonElement, private expanded: () => boolean, private onHold: (hold: boolean) => void) {
    super();
    this.win = viewport.ownerDocument?.defaultView ?? window;
    this.registerDomEvent(viewport, 'scroll', () => {
      const near = this.nearBottom();
      if (viewport.scrollTop < this.lastTop || near) this.following = near;
      this.lastTop = viewport.scrollTop;
      this.refresh();
    });
    this.registerDomEvent(button, 'click', () => this.catchUp());
    const Resize = (this.win as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (Resize) {
      this.observer = new Resize(() => this.afterGrowth());
      this.observer.observe(viewport);
    }
  }
  private nearBottom(): boolean { return this.viewport.scrollHeight - this.viewport.scrollTop - this.viewport.clientHeight <= 8; }
  beforeGrowth(): void {
    // Scroll events, not growth, disengage following. Observe an upward move
    // even when its queued scroll event has not fired yet.
    if (this.viewport.scrollTop < this.lastTop && !this.nearBottom()) this.following = false;
    this.lastTop = this.viewport.scrollTop;
  }
  afterGrowth(): void {
    this.refresh();
    if (this.frame !== null || !this.expanded()) return;
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = null;
      this.beforeGrowth();
      if (this.following) this.viewport.scrollTop = this.viewport.scrollHeight;
      this.lastTop = this.viewport.scrollTop;
      this.refresh();
    });
  }
  restorePosition(top: number): void {
    this.viewport.scrollTop = top;
    this.lastTop = this.viewport.scrollTop;
    this.afterGrowth();
  }
  catchUp(): void { this.following = true; this.afterGrowth(); }
  refresh(): void {
    this.button.hidden = !this.expanded() || this.following || this.nearBottom();
    this.onHold(this.expanded() && !this.following);
  }
  onunload(): void {
    if (this.frame !== null) this.win.cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    this.onHold(false);
  }
}
