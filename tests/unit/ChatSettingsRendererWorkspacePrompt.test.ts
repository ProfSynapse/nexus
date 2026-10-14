/**
 * Choosing a workspace in Defaults preselects the prompt bound to it.
 *
 * Failure this buys: WorkspaceFormRenderer saves the binding as the top-level
 * `dedicatedAgentId`, and WorkspacePromptResolver treats that as canonical with
 * `context.dedicatedAgent` deprecated. The renderer used to read only the
 * deprecated path, and DefaultsTab passed only `{ id, name }`, so the prompt
 * never followed the workspace there.
 *
 * Real pieces: ChatSettingsRenderer.renderContextSection and its workspace
 * dropdown handler, DefaultsTab.loadWorkspaces. Faked: the dropdown and
 * element mocks (they only capture the registered callbacks).
 */
import { Component } from 'obsidian';
import { DropdownComponent } from '../mocks/obsidian/components';
import { createMockElement } from '../helpers/mockFactories';
import { ChatSettingsRenderer, type ChatSettingsOptions } from '../../src/components/shared/ChatSettingsRenderer';
import { DefaultsTab } from '../../src/settings/tabs/DefaultsTab';

type RendererInternals = {
  settings: { workspaceId: string | null; promptId: string | null; workflowId?: string | null; contextNotes: string[] };
  config: { options: ChatSettingsOptions; showWorkflowSelection?: boolean };
  notifyChange: jest.Mock;
  render: jest.Mock;
  renderContextSection(parent: HTMLElement): void;
};

function renderer(workspaces: ChatSettingsOptions['workspaces']): RendererInternals {
  const r = Object.create(ChatSettingsRenderer.prototype) as RendererInternals;
  r.settings = { workspaceId: null, promptId: null, contextNotes: [] };
  r.config = {
    options: {
      workspaces,
      prompts: [{ id: 'Writer', name: 'Writer' }, { id: 'Editor', name: 'Editor' }]
    }
  };
  r.notifyChange = jest.fn();
  r.render = jest.fn();
  return r;
}

/** Render the Context section and return the Workspace dropdown's change handler. */
function workspaceDropdown(r: RendererInternals): (value: string) => void {
  const handlers: Array<(value: string) => void> = [];
  const onChange = jest.spyOn(DropdownComponent.prototype, 'onChange').mockImplementation(function (callback) {
    handlers.push(callback);
    return this;
  });
  try {
    r.renderContextSection(createMockElement('div') as unknown as HTMLElement);
  } finally {
    onChange.mockRestore();
  }
  // Workspace is the first dropdown in the Context section.
  return handlers[0];
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

it('context note buttons register their clicks through a Component, not onclick', () => {
  const r = renderer([]);
  (r.settings as { contextNotes: string[] }).contextNotes = ['Notes/a.md'];
  const registered: Array<{ type: string }> = [];
  const register = jest.spyOn(Component.prototype, 'registerDomEvent').mockImplementation((_el, type) => {
    registered.push({ type: String(type) });
  });
  try {
    workspaceDropdown(r);
  } finally {
    register.mockRestore();
  }
  // "Add" in the header plus one remove button for the single note.
  expect(registered.filter(entry => entry.type === 'click')).toHaveLength(2);
});
