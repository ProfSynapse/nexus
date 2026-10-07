jest.mock('../../src/services/mcp/MCPConnectionManager', () => ({}));
jest.mock('../../src/services/agent/AgentRegistrationService', () => ({}));
jest.mock('../../src/agents', () => ({}));
jest.mock('../../src/agents/promptManager/services/CustomPromptStorageService', () => ({}));

import { MCPConnector } from '../../src/connector';

describe('MCPConnector unload while starting', () => {
  it('does not start a transport after agent initialization finishes on an unloaded connector', async () => {
    const connector = Object.create(MCPConnector.prototype) as MCPConnector;
    let finish!: () => void;
    const initialized = new Promise<void>(resolve => { finish = resolve; });
    const initialization = jest.spyOn(connector, 'initializeAgents').mockReturnValue(initialized);
    const server = { releaseIpcSocket: jest.fn() };
    const connection = { getServer: () => server, start: jest.fn() };
    (connector as unknown as { connectionManager: unknown }).connectionManager = connection;
    const startup = connector.start();
    connector.releaseIpcSocket(); finish(); await startup;
    expect(server.releaseIpcSocket).toHaveBeenCalledTimes(1);
    expect(connection.start).not.toHaveBeenCalled();
    await connector.start(); expect(initialization).toHaveBeenCalledTimes(1);
  });
});
