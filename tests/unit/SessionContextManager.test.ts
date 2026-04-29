import { SessionContextManager } from '../../src/services/SessionContextManager';

describe('SessionContextManager', () => {
  it('keeps a friendly session handle model-facing while storing an internal ID', async () => {
    const manager = new SessionContextManager();
    const sessionService = {
      getSession: jest.fn().mockResolvedValue(null),
      getAllSessions: jest.fn().mockResolvedValue([]),
      createSession: jest.fn(),
      updateSession: jest.fn()
    };
    manager.setSessionService(sessionService);

    const result = await manager.validateSessionId('workspace setup', 'Testing session handles', 'default');

    expect(result.id).toMatch(/^s-/);
    expect(result.displaySessionId).toBe('workspace setup');
    expect(result.displaySessionIdChanged).toBe(false);
    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: result.id,
        name: 'workspace setup',
        description: 'Testing session handles',
        workspaceId: 'default'
      })
    );

    await expect(manager.validateSessionId('workspace setup', undefined, 'default')).resolves.toEqual(
      expect.objectContaining({
        id: result.id,
        created: false,
        displaySessionId: 'workspace setup',
        displaySessionIdChanged: false
      })
    );
  });

  it('suffixes duplicate friendly session handles and reports the display handle', async () => {
    const manager = new SessionContextManager();
    const sessionService = {
      getSession: jest.fn().mockResolvedValue(null),
      getAllSessions: jest.fn().mockResolvedValue([
        { id: 's-existing', workspaceId: 'default', name: 'session' }
      ]),
      createSession: jest.fn(),
      updateSession: jest.fn()
    };
    manager.setSessionService(sessionService);

    const result = await manager.validateSessionId('session', undefined, 'default');

    expect(result.displaySessionId).toBe('session-2');
    expect(result.displaySessionIdChanged).toBe(true);
    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'session-2'
      })
    );

    await expect(manager.validateSessionId('session-2', undefined, 'default')).resolves.toEqual(
      expect.objectContaining({
        id: result.id,
        created: false,
        displaySessionId: 'session-2'
      })
    );
  });
});
