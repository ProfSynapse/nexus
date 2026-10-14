/**
 * Choosing a workspace in Defaults preselects the prompt bound to it.
 *
 * Failure this buys: WorkspaceFormRenderer saves the binding as the top-level
 * `dedicatedAgentId`, and WorkspacePromptResolver treats that as canonical with
 * `context.dedicatedAgent` deprecated. The renderer used to read only the
 * deprecated path, and DefaultsTab passed only `{ id, name }`, so the prompt
 * never followed the workspace there.
 *
 * Real pieces: ChatSettingsRenderer.renderContext and its workspace dropdown
 * handler, DefaultsTab.loadWorkspaces. Rows render into the FakeElement tree
 * and the dropdown is driven by a change event.
 */
import { Component } from 'obsidian';
import { createFakeRoot, FakeElement } from '../mocks/obsidian/dom';
import { ChatSettingsRenderer, type ChatSettingsOptions } from '../../src/components/shared/ChatSettingsRenderer';
import { DefaultsTab } from '../../src/settings/tabs/DefaultsTab';
import { choose, control, findRow } from '../helpers/settingsDom';

type RendererInternals = {
  settings: { workspaceId: string | null; promptId: string | null; workflowId?: string | null; contextNotes: string[] };
  config: { options: ChatSettingsOptions; surface: 'defaults' | 'chat' };
  notifyChange: jest.Mock;
  redrawGroups: jest.Mock;
  events(groupId: string): Component;
  renderContext(itemsEl: HTMLElement): void;
};

function renderer(workspaces: ChatSettingsOptions['workspaces']): RendererInternals {
  const r = Object.create(ChatSettingsRenderer.prototype) as RendererInternals;
  r.settings = { workspaceId: null, promptId: null, contextNotes: [] };
  r.config = {
    surface: 'defaults',
    options: {
      workspaces,
      prompts: [{ id: 'Writer', name: 'Writer' }, { id: 'Editor', name: 'Editor' }]
    }
  };
  r.notifyChange = jest.fn();
  r.redrawGroups = jest.fn();
  return r;
}

/** Render the Context rows and return the Workspace dropdown. */
function renderContext(r: RendererInternals): FakeElement {
  const items = createFakeRoot();
  r.renderContext(items as unknown as HTMLElement);
  return items;
}

function workspaceDropdown(r: RendererInternals): (value: string) => void {
  const items = renderContext(r);
  return (value: string) => choose(control(findRow(items, 'Workspace'), 'select'), value);
}

it('selecting a workspace whose top-level dedicatedAgentId names a prompt selects that prompt', () => {
  const r = renderer([{ id: 'ws1', name: 'Novel', dedicatedAgentId: 'Writer' }]);
  workspaceDropdown(r)('ws1');
  expect(r.settings.workspaceId).toBe('ws1');
  expect(r.settings.promptId).toBe('Writer');
});

it('the top-level binding wins over the deprecated context.dedicatedAgent', () => {
  const r = renderer([{
    id: 'ws1', name: 'Novel', dedicatedAgentId: 'Writer',
    context: { dedicatedAgent: { agentId: 'Editor', agentName: 'Editor' } }
  }]);
  workspaceDropdown(r)('ws1');
  expect(r.settings.promptId).toBe('Writer');
});

it('falls back to the deprecated context.dedicatedAgent when no top-level binding exists', () => {
  const r = renderer([{ id: 'ws1', name: 'Novel', context: { dedicatedAgent: { agentId: 'Editor', agentName: 'Editor' } } }]);
  workspaceDropdown(r)('ws1');
  expect(r.settings.promptId).toBe('Editor');
});

it('DefaultsTab hands the workspace prompt binding to the renderer', async () => {
  const tab = Object.create(DefaultsTab.prototype) as { services: unknown; loadWorkspaces(): Promise<ChatSettingsOptions['workspaces']> };
  const context = { purpose: 'Write', dedicatedAgent: { agentId: 'Editor', agentName: 'Editor' } };
  tab.services = {
    workspaceService: {
      getAllWorkspaces: jest.fn(async () => [{ id: 'ws1', name: 'Novel', dedicatedAgentId: 'Writer', context, sessions: {} }])
    }
  };
  expect(await tab.loadWorkspaces()).toEqual([{ id: 'ws1', name: 'Novel', dedicatedAgentId: 'Writer', context }]);
});

it('context note rows use Obsidian components, not onclick or hand-made buttons', () => {
  const r = renderer([]);
  r.settings.contextNotes = ['Notes/a.md'];
  const items = renderContext(r);
  const remove = control(findRow(items, 'a'), '.extra-setting-button');
  expect(remove.getAttribute('aria-label')).toBe('Remove a');
  expect(items.querySelectorAll('.csr-add-btn, .csr-note-remove')).toEqual([]);
  remove.click();
  expect(r.settings.contextNotes).toEqual([]);
  expect(r.notifyChange).toHaveBeenCalledTimes(1);
  expect(r.redrawGroups).toHaveBeenCalledWith(['context']);
});
