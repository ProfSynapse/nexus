/** Native dismissal must not tear down a valid draft until durable saving succeeds. */
import { App } from 'obsidian';
import { OpenAICompatibleModal } from '../../src/components/openai-compatible/OpenAICompatibleModal';
import { CompatibleEndpointConfig, OpenAICompatibleEditSession } from '../../src/components/openai-compatible/OpenAICompatibleEditSession';

function config(): CompatibleEndpointConfig {
  return { apiKey: '', enabled: true, driverKind: 'openai-compatible', openaiCompatible: { schemaVersion: 1, displayName: 'Home', baseUrl: 'https://models.example/v1', models: {} } };
}

type EditorState = { editor: OpenAICompatibleEditSession; dirty: boolean; opened: boolean; status: { setText: jest.Mock }; saveVersion: number };

function modalWithDraft(persist: (id: string, value: CompatibleEndpointConfig) => Promise<void>): { modal: OpenAICompatibleModal; state: EditorState; closed: jest.SpyInstance } {
  const modal = new OpenAICompatibleModal(new App(), { getProviders: () => ({}), save: persist });
  const state = modal as unknown as EditorState;
  state.editor = new OpenAICompatibleEditSession('custom-1', config(), persist);
  state.dirty = true;
  state.opened = true;
  state.status = { setText: jest.fn() };
  return { modal, state, closed: jest.spyOn(modal, 'onClose') };
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

describe('OpenAI-compatible modal save lifecycle', () => {
  it('keeps a failed draft visible and allows closing to retry', async () => {
    const persist = jest.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined);
    const { modal, state, closed } = modalWithDraft(persist);
    modal.close();
    await settle();
    expect(closed).not.toHaveBeenCalled();
    expect(state.dirty).toBe(true);
    expect(state.status.setText).toHaveBeenLastCalledWith('Save failed. Change a field or close to retry.');
    modal.close();
    await settle();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('waits for edits made during an earlier save before closing', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const persisted: string[] = [];
    const persist = jest.fn(async (_id: string, value: CompatibleEndpointConfig) => {
      if (value.openaiCompatible.displayName === 'Home') await pending;
      persisted.push(value.openaiCompatible.displayName);
    });
    const { modal, state, closed } = modalWithDraft(persist);
    modal.close();
    await settle();
    expect(closed).not.toHaveBeenCalled();
    state.editor.setName('Renamed while saving');
    state.saveVersion++;
    release();
    await settle();
    expect(persisted).toEqual(['Home', 'Renamed while saving']);
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
