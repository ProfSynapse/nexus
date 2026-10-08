/** Native dismissal must preserve valid drafts when persistence fails. */
import { App, DropdownComponent, Setting, TextComponent } from 'obsidian';
import { RemoteAgentModal, connectionCheckMessage, connectionAvailabilityLabel } from '../../src/settings/remoteAgents/RemoteAgentModal';
import { RemoteAgentEditSession } from '../../src/settings/remoteAgents/RemoteAgentEditSession';
import { normalizeRemoteAgentBaseUrl } from '../../src/services/remoteAgents/HermesConnector';
import { normalizeRemoteAgentConnectionUrl } from '../../src/services/remoteAgents/RemoteAgentConfig';
import type { RemoteAgentConnection } from '../../src/services/remoteAgents/types';

type EditorState = { editor: RemoteAgentEditSession; dirty: boolean; opened: boolean; status: { setText: jest.Mock }; version: number };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function modalWithDraft(save: (value: RemoteAgentConnection) => Promise<void>) {
  const connection: RemoteAgentConnection = { id: 'remote-1', connector: 'hermes', displayName: 'Home', baseUrl: 'https://hermes.example/v1', apiKey: '', enabled: true };
  const modal = new RemoteAgentModal(new App(), connection, { save, normalizeUrl: normalizeRemoteAgentBaseUrl, check: jest.fn() });
  const state = modal as unknown as EditorState;
  state.dirty = true;
  state.opened = true;
  state.status = { setText: jest.fn() };
  return { modal, state, closed: jest.spyOn(modal, 'onClose') };
}

describe('Remote agent settings lifecycle', () => {
  it('persists an agent-type selection from the dropdown and updates its URL field in place', async () => {
    jest.useFakeTimers();
    let selectType!: (value: string) => void;
    const change = jest.spyOn(DropdownComponent.prototype, 'onChange').mockImplementation(function (callback) { selectType = callback; return this; });
    const addOption = jest.spyOn(DropdownComponent.prototype, 'addOption');
    const name = jest.spyOn(Setting.prototype, 'setName');
    const placeholder = jest.spyOn(TextComponent.prototype, 'setPlaceholder');
    const save = jest.fn(async () => undefined);
    const modal = new RemoteAgentModal(new App(), { id: 'home', connector: 'hermes', displayName: 'Home', baseUrl: 'https://gateway.example', apiKey: 'retained-key', enabled: true }, { save, normalizeUrl: normalizeRemoteAgentConnectionUrl, check: jest.fn() });
    try {
      modal.open();
      expect(addOption).toHaveBeenCalledWith('openclaw', 'OpenClaw');
      selectType('openclaw');
      expect(name).toHaveBeenCalledWith('Gateway URL');
      expect(placeholder).toHaveBeenLastCalledWith('wss://openclaw.example.com');
      await jest.advanceTimersByTimeAsync(400);
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ connector: 'openclaw', baseUrl: 'wss://gateway.example', apiKey: 'retained-key' }));
    } finally {
      modal.onClose();
      change.mockRestore(); addOption.mockRestore(); name.mockRestore(); placeholder.mockRestore();
      jest.useRealTimers();
    }
  });

  it('keeps a failed draft visible and retries on close', async () => {
    const save = jest.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined);
    const { modal, state, closed } = modalWithDraft(save);
    modal.close();
    await settle();
    expect(closed).not.toHaveBeenCalled();
    expect(state.dirty).toBe(true);
    modal.close();
    await settle();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('flushes metadata edited while a prior close save is in progress', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const names: string[] = [];
    const { modal, state, closed } = modalWithDraft(async value => {
      if (value.displayName === 'Home') await pending;
      names.push(value.displayName);
    });
    modal.close();
    await settle();
    state.editor.update({ displayName: 'Team' });
    state.version++;
    release();
    await settle();
    expect(names).toEqual(['Home', 'Team']);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('labels a chat-only or unverified server as unavailable for resumable tasks', () => {
    expect(connectionCheckMessage({ connected: true, runsAvailable: true, durableIdempotency: false, checkedAt: 1 })).toContain('unavailable');
    expect(connectionCheckMessage({ connected: true, runsAvailable: false, durableIdempotency: true, checkedAt: 1 })).toContain('unavailable');
    expect(connectionCheckMessage({ connected: true, runsAvailable: true, durableIdempotency: true, checkedAt: 1 })).toContain('unavailable');
    expect(connectionCheckMessage({ connected: true, runsAvailable: true, durableIdempotency: true, idempotencyRetentionMs: 60000, checkedAt: 1 })).toContain('Connection ready');
  });

  it('shows disabled, checking and unavailable cards without claiming readiness', () => {
    const health = { connected: true, runsAvailable: true, durableIdempotency: true, idempotencyRetentionMs: 60000, checkedAt: 1 };
    expect(connectionAvailabilityLabel(false, health)).toBe('Disabled');
    expect(connectionAvailabilityLabel(true, health, true)).toBe('Checking connection…');
    expect(connectionAvailabilityLabel(true)).toBe('Not checked');
    expect(connectionAvailabilityLabel(true, { ...health, connected: false })).toBe('Connection unavailable');
    expect(connectionAvailabilityLabel(true, { ...health, runsAvailable: false })).toBe('Remote tasks unavailable');
    expect(connectionAvailabilityLabel(true, health)).toBe('Available');
  });

  it('accepts session-history recovery without claiming replay safety', () => {
    const health = { connected: true, runsAvailable: true, durableIdempotency: false, recoveryMode: 'session-history' as const, checkedAt: 1 };
    expect(connectionAvailabilityLabel(true, health)).toBe('Available');
    expect(connectionCheckMessage(health)).toContain('Connection ready');
    expect(connectionAvailabilityLabel(true, { ...health, runsAvailable: false })).toBe('Remote tasks unavailable');
    expect(connectionAvailabilityLabel(true, { ...health, connected: false })).toBe('Connection unavailable');
  });
});
