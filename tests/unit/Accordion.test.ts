/**
 * The shared settings Accordion.
 *
 * Failures this buys: the old component created a NEW content div on every
 * getContentEl() call (so a caller that asked twice split its rows across two
 * containers), had no icon or summary, kept no aria state and hid content by
 * class only. Rendering into a FakeElement tree lets the assertions read the
 * markup Obsidian would show.
 */
import { createFakeRoot, FakeElement } from '../mocks/obsidian/dom';
import { Accordion } from '../../src/components/Accordion';

function build(options: Partial<ConstructorParameters<typeof Accordion>[1]> = {}) {
  const root = createFakeRoot();
  const onToggle = jest.fn();
  const accordion = new Accordion(root as unknown as HTMLElement, {
    id: 'context', title: 'Context', icon: 'layers', summary: 'No workspace · No prompt · 0 notes', onToggle, ...options
  });
  const el = (selector: string) => (accordion.rootEl as unknown as FakeElement).querySelector(selector) as FakeElement;
  return { root, accordion, onToggle, el };
}

it('is collapsed by default with its summary showing', () => {
  const { accordion, el } = build();
  expect(accordion.isOpen).toBe(false);
  expect(el('.nexus-accordion-toggle').getAttribute('aria-expanded')).toBe('false');
  expect(el('.nexus-accordion-content').hidden).toBe(true);
  expect((accordion.rootEl as unknown as FakeElement).hasClass('is-open')).toBe(false);
  expect(el('.nexus-accordion-summary').hidden).toBe(false);
  expect(el('.nexus-accordion-summary').textContent).toBe('No workspace · No prompt · 0 notes');
});

it('renders the icon, title and a chevron that follows the state', () => {
  const { el } = build();
  expect(el('.nexus-accordion-icon').getAttribute('data-icon')).toBe('layers');
  expect(el('.nexus-accordion-title').textContent).toBe('Context');
  expect(el('.nexus-accordion-chevron').getAttribute('data-icon')).toBe('chevron-down');
});

it('toggling flips aria-expanded, hidden, is-open, the chevron and hides the summary', () => {
  const { accordion, el, onToggle } = build();
  el('.nexus-accordion-toggle').click();
  expect(accordion.isOpen).toBe(true);
  expect(el('.nexus-accordion-toggle').getAttribute('aria-expanded')).toBe('true');
  expect(el('.nexus-accordion-content').hidden).toBe(false);
  expect((accordion.rootEl as unknown as FakeElement).hasClass('is-open')).toBe(true);
  expect(el('.nexus-accordion-summary').hidden).toBe(true);
  expect(el('.nexus-accordion-chevron').getAttribute('data-icon')).toBe('chevron-up');
  expect(onToggle).toHaveBeenCalledTimes(1);
  expect(onToggle).toHaveBeenCalledWith(true);

  el('.nexus-accordion-toggle').click();
  expect(onToggle).toHaveBeenCalledTimes(2);
  expect(onToggle).toHaveBeenLastCalledWith(false);
  expect(el('.nexus-accordion-summary').hidden).toBe(false);
});

it('ties the toggle to its content with aria-controls and a unique id', () => {
  const first = build();
  const second = build();
  const controls = first.el('.nexus-accordion-toggle').getAttribute('aria-controls');
  expect(controls).toBeTruthy();
  expect(first.el('.nexus-accordion-content').id).toBe(controls);
  expect(second.el('.nexus-accordion-content').id).not.toBe(controls);
});

it('exposes one stable setting-items list inside a setting-group content element', () => {
  const { accordion, el } = build();
  const items = accordion.itemsEl;
  expect(accordion.itemsEl).toBe(items);
  const content = el('.nexus-accordion-content');
  expect(content.hasClass('setting-group')).toBe(true);
  expect(content.children).toEqual([items]);
  expect((items as unknown as FakeElement).hasClass('setting-items')).toBe(true);
});

it('setOpen restores remembered state without calling onToggle when silent', () => {
  const { accordion, onToggle, el } = build();
  accordion.setOpen(true, { silent: true });
  expect(accordion.isOpen).toBe(true);
  expect(el('.nexus-accordion-content').hidden).toBe(false);
  expect(onToggle).not.toHaveBeenCalled();
  accordion.setOpen(true);
  expect(onToggle).not.toHaveBeenCalled();
});

it('starts open when asked and keeps a later summary hidden until it closes', () => {
  const { accordion, el } = build({ open: true });
  accordion.setSummary('Workspace · Prompt · 2 notes');
  expect(el('.nexus-accordion-summary').hidden).toBe(true);
  accordion.setOpen(false);
  expect(el('.nexus-accordion-summary').hidden).toBe(false);
  expect(el('.nexus-accordion-summary').textContent).toBe('Workspace · Prompt · 2 notes');
});

it('removes its click listener on unload', () => {
  const { accordion, el } = build();
  const toggle = el('.nexus-accordion-toggle');
  expect(toggle.listenerCount('click')).toBe(1);
  accordion.unload();
  expect(toggle.listenerCount('click')).toBe(0);
});

it('wraps the toggle in a heading and labels the content region by it (WAI-ARIA accordion)', () => {
  const { accordion, el } = build();
  const heading = el('.nexus-accordion-heading');
  expect(heading.getAttribute('role')).toBe('heading');
  expect(heading.getAttribute('aria-level')).toBe('3');
  expect((accordion.rootEl as unknown as FakeElement).children[0]).toBe(heading);
  expect(heading.children).toEqual([accordion.toggleEl]);

  const toggleId = el('.nexus-accordion-toggle').getAttribute('id');
  expect(toggleId).toBeTruthy();
  const content = el('.nexus-accordion-content');
  expect(content.getAttribute('role')).toBe('region');
  expect(content.getAttribute('aria-labelledby')).toBe(toggleId);

  expect(build({ headingLevel: 2 }).el('.nexus-accordion-heading').getAttribute('aria-level')).toBe('2');
});

it('unload() removes the click listener, as it does in Obsidian (which skips never-loaded components)', () => {
  const { accordion, el, onToggle } = build();
  expect(el('.nexus-accordion-toggle').listenerCount('click')).toBe(1);
  accordion.unload();
  expect(el('.nexus-accordion-toggle').listenerCount('click')).toBe(0);
  el('.nexus-accordion-toggle').click();
  expect(onToggle).not.toHaveBeenCalled();
});
