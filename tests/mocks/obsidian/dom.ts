/**
 * A small element tree for tests that need to observe rendered structure.
 *
 * The default `createMockElement` records calls but keeps no tree, so a test
 * cannot see the order rows render in, whether a fold is hidden, or whether a
 * redraw replaced a node. `FakeElement` keeps children in insertion order,
 * honours `empty()`/`remove()`, tracks `isConnected` from a root, supports the
 * Obsidian element helpers production code calls (`createEl`, `createDiv`,
 * `addClass`, `setText`, `setAttr`, ...), dispatches events registered through
 * `addEventListener`, and answers simple `querySelector` calls (tag, `.class`,
 * `#id`, `[attr]`, `[attr="value"]`, compound and comma lists, descendant only).
 *
 * The Setting and component mocks build a real-looking subtree when they are
 * handed a FakeElement container, and fall back to `createMockElement` for every
 * other container, so suites that never use this file behave exactly as before.
 */

type ElementInfo = string | {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string | number | boolean | null>;
  type?: string;
  value?: string;
  title?: string;
  href?: string;
  placeholder?: string;
};

type Listener = (event: FakeEvent) => void;

export interface FakeEvent {
  type: string;
  target: FakeElement;
  currentTarget: FakeElement;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  key?: string;
}

function splitClasses(cls: string | string[] | undefined): string[] {
  if (!cls) return [];
  const list = Array.isArray(cls) ? cls : [cls];
  return list.flatMap(item => item.split(/\s+/)).filter(Boolean);
}

export class FakeElement {
  tagName: string;
  readonly classes = new Set<string>();
  readonly attributes = new Map<string, string>();
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  hidden = false;
  disabled = false;
  value = '';
  type = '';
  checked = false;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  private ownText = '';
  private isRoot = false;
  private listeners = new Map<string, Set<Listener>>();

  constructor(tagName = 'div', info?: ElementInfo) {
    this.tagName = tagName.toUpperCase();
    if (info !== undefined) this.applyInfo(info);
  }

  static root(tagName = 'div'): FakeElement {
    const el = new FakeElement(tagName);
    el.isRoot = true;
    return el;
  }

  private applyInfo(info: ElementInfo): void {
    const opts = typeof info === 'string' ? { cls: info } : info;
    splitClasses(opts.cls).forEach(cls => this.classes.add(cls));
    if (opts.text !== undefined) this.ownText = opts.text;
    if (opts.type !== undefined) this.type = opts.type;
    if (opts.value !== undefined) this.value = opts.value;
    if (opts.title !== undefined) this.setAttribute('title', opts.title);
    if (opts.href !== undefined) this.setAttribute('href', opts.href);
    if (opts.placeholder !== undefined) this.setAttribute('placeholder', opts.placeholder);
    for (const [key, value] of Object.entries(opts.attr ?? {})) {
      if (value === null || value === false) continue;
      this.setAttribute(key, String(value));
    }
  }

  // ---- tree ----

  get isConnected(): boolean {
    let node: FakeElement | null = this;
    while (node) {
      if (node.isRoot) return true;
      node = node.parentElement;
    }
    return false;
  }

  get firstElementChild(): FakeElement | null {
    return this.children.find(child => child.tagName !== '#TEXT') ?? null;
  }

  get lastElementChild(): FakeElement | null {
    const elements = this.children.filter(child => child.tagName !== '#TEXT');
    return elements[elements.length - 1] ?? null;
  }

  get childElementCount(): number {
    return this.children.filter(child => child.tagName !== '#TEXT').length;
  }

  createEl(tag: string, info?: ElementInfo, callback?: (el: FakeElement) => void): FakeElement {
    const child = new FakeElement(tag, info);
    this.appendChild(child);
    callback?.(child);
    return child;
  }

  createDiv(info?: ElementInfo, callback?: (el: FakeElement) => void): FakeElement {
    return this.createEl('div', info, callback);
  }

  createSpan(info?: ElementInfo, callback?: (el: FakeElement) => void): FakeElement {
    return this.createEl('span', info, callback);
  }

  appendChild<T extends FakeElement>(child: T): T {
    child.detach();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) {
      if (typeof node === 'string') this.appendText(node);
      else this.appendChild(node);
    }
  }

  prepend(child: FakeElement): void {
    child.detach();
    child.parentElement = this;
    this.children.unshift(child);
  }

  insertBefore<T extends FakeElement>(child: T, reference: FakeElement | null): T {
    if (!reference) return this.appendChild(child);
    child.detach();
    const index = this.children.indexOf(reference);
    child.parentElement = this;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  appendText(text: string): void {
    const node = new FakeElement('#text');
    node.ownText = text;
    this.appendChild(node);
  }

  detach(): void {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentElement = null;
  }

  remove(): void {
    this.detach();
  }

  empty(): void {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.ownText = '';
  }

  contains(other: FakeElement | null): boolean {
    for (let node = other; node; node = node.parentElement) {
      if (node === this) return true;
    }
    return false;
  }

  // ---- text ----

  get textContent(): string {
    return this.ownText + this.children.map(child => child.textContent).join('');
  }

  set textContent(value: string) {
    this.empty();
    this.ownText = value;
  }

  get innerText(): string {
    return this.textContent;
  }

  setText(text: string | { textContent?: string }): void {
    this.textContent = typeof text === 'string' ? text : text.textContent ?? '';
  }

  // ---- classes ----

  get className(): string {
    return Array.from(this.classes).join(' ');
  }

  get classList(): { add(...c: string[]): void; remove(...c: string[]): void; toggle(c: string, force?: boolean): boolean; contains(c: string): boolean } {
    return {
      add: (...cls: string[]) => this.addClass(...cls),
      remove: (...cls: string[]) => this.removeClass(...cls),
      toggle: (cls: string, force?: boolean) => {
        const next = force ?? !this.classes.has(cls);
        this.toggleClass(cls, next);
        return next;
      },
      contains: (cls: string) => this.classes.has(cls)
    };
  }

  addClass(...cls: string[]): void {
    cls.flatMap(item => splitClasses(item)).forEach(item => this.classes.add(item));
  }

  addClasses(cls: string[]): void {
    this.addClass(...cls);
  }

  removeClass(...cls: string[]): void {
    cls.flatMap(item => splitClasses(item)).forEach(item => this.classes.delete(item));
  }

  toggleClass(cls: string | string[], value: boolean): void {
    if (value) this.addClass(...splitClasses(cls));
    else this.removeClass(...splitClasses(cls));
  }

  hasClass(cls: string): boolean {
    return this.classes.has(cls);
  }

  // ---- attributes ----

  get id(): string {
    return this.attributes.get('id') ?? '';
  }

  set id(value: string) {
    this.attributes.set('id', value);
  }

  setAttribute(name: string, value: string): void {
    if (name === 'id') this.id = String(value);
    else this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  setAttr(name: string, value: string | number | boolean | null): void {
    if (value === null || value === false) this.removeAttribute(name);
    else this.setAttribute(name, String(value));
  }

  setAttrs(attrs: Record<string, string | number | boolean | null>): void {
    for (const [name, value] of Object.entries(attrs)) this.setAttr(name, value);
  }

  setCssProps(props: Record<string, string>): void {
    Object.assign(this.style, props);
  }

  isShown(): boolean {
    for (let node: FakeElement | null = this; node; node = node.parentElement) {
      if (node.hidden) return false;
    }
    return true;
  }

  // ---- events ----

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  dispatch(type: string, extra: Partial<FakeEvent> = {}): FakeEvent {
    const event: FakeEvent = {
      type,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { /* no bubbling in this tree */ },
      ...extra
    };
    for (const listener of Array.from(this.listeners.get(type) ?? [])) listener(event);
    return event;
  }

  click(): void {
    if (this.disabled) return;
    this.dispatch('click');
  }

  focus(): void {
    /* no focus model */
  }

  // ---- queries ----

  matches(selector: string): boolean {
    return selector.split(',').some(part => matchesCompound(this, part.trim()));
  }

  closest(selector: string): FakeElement | null {
    for (let node: FakeElement | null = this; node; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const parts = selector.split(',').map(part => part.trim());
    const found: FakeElement[] = [];
    const walk = (node: FakeElement): void => {
      for (const child of node.children) {
        if (child.tagName !== '#TEXT' && parts.some(part => matchesDescendant(child, part, this))) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /** Test helper: every descendant element, depth first, in document order. */
  descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (node: FakeElement): void => {
      for (const child of node.children) {
        if (child.tagName === '#TEXT') continue;
        out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

/** `a .b` style descendant matching, scoped below `scope`. */
function matchesDescendant(el: FakeElement, selector: string, scope: FakeElement): boolean {
  const scoped = selector.startsWith(':scope >');
  const steps = (scoped ? selector.slice(':scope >'.length) : selector).trim().split(/\s+/);
  if (scoped) return steps.length === 1 && el.parentElement === scope && matchesCompound(el, steps[0]);
  if (!matchesCompound(el, steps[steps.length - 1])) return false;
  let node = el.parentElement;
  for (let index = steps.length - 2; index >= 0; index--) {
    while (node && node !== scope && !matchesCompound(node, steps[index])) node = node.parentElement;
    if (!node || node === scope) return false;
    node = node.parentElement;
  }
  return true;
}

function matchesCompound(el: FakeElement, selector: string): boolean {
  if (!selector) return false;
  const tokens = selector.match(/(^[a-zA-Z][\w-]*)|(\.[\w-]+)|(#[\w-]+)|(\[[^\]]+\])/g);
  if (!tokens || tokens.join('') !== selector) return false;
  return tokens.every(token => {
    if (token.startsWith('.')) return el.classes.has(token.slice(1));
    if (token.startsWith('#')) return el.id === token.slice(1);
    if (token.startsWith('[')) {
      const body = token.slice(1, -1);
      const eq = body.indexOf('=');
      if (eq < 0) return el.hasAttribute(body);
      const name = body.slice(0, eq);
      const value = body.slice(eq + 1).replace(/^["']|["']$/g, '');
      return el.getAttribute(name) === value;
    }
    return el.tagName === token.toUpperCase();
  });
}

export function isFakeElement(value: unknown): value is FakeElement {
  return value instanceof FakeElement;
}

/** A connected root to render into. */
export function createFakeRoot(tagName = 'div'): FakeElement {
  return FakeElement.root(tagName);
}
