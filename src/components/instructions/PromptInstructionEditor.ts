import { Component, Setting } from 'obsidian';
import { BoxedSection } from '../../settings/components/BoxedSection';
import type { InstructionDraft } from './InstructionDraft';

export function renderPromptInstructions(container: HTMLElement, draft: InstructionDraft, component: Component, changed: () => void): void {
  new BoxedSection(container, { title: 'Instructions', unbounded: true, body: body => {
    new Setting(body).setName('Instructions').setDesc('The complete instruction text for this prompt.').addTextArea(text => {
      text.setValue(draft.body).onChange(value => { draft.body = value; changed(); });
      text.inputEl.rows = 8;
      text.inputEl.setAttribute('aria-label', 'Prompt instructions');
    });
  } }, component);
}
