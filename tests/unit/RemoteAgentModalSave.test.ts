/** Native dismissal must preserve valid drafts when persistence fails. */
import { App } from 'obsidian';
import { RemoteAgentModal, connectionCheckMessage, connectionAvailabilityLabel } from '../../src/settings/remoteAgents/RemoteAgentModal';
import { RemoteAgentEditSession } from '../../src/settings/remoteAgents/RemoteAgentEditSession';
import { normalizeRemoteAgentBaseUrl } from '../../src/services/remoteAgents/HermesConnector';
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
    expect(connectionCheckMessage({ connected: true, runsAvailable: true, durableIdempotency: true, checkedAt: 1 })).toContain('Connection ready');
  });

  it('shows disabled, checking and unavailable cards without claiming readiness', () => {
    const health = { connected: true, runsAvailable: true, durableIdempotency: true, checkedAt: 1 };
    expect(connectionAvailabilityLabel(false, health)).toBe('Disabled');
    expect(connectionAvailabilityLabel(true, health, true)).toBe('Checking connection…');
    expect(connectionAvailabilityLabel(true)).toBe('Not checked');
    expect(connectionAvailabilityLabel(true, { ...health, connected: false })).toBe('Connection unavailable');
    expect(connectionAvailabilityLabel(true, { ...health, runsAvailable: false })).toBe('Remote tasks unavailable');
    expect(connectionAvailabilityLabel(true, health)).toBe('Available');
  });
});
