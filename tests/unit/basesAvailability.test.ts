/**
 * tests/unit/basesAvailability.test.ts
 *
 * The availability gate: no Bases, no agent.
 *
 * `registerBasesView` is both the probe and the registration, so these tests
 * pin the three things that decide whether the `base` commands exist at all —
 * an app too old to have the API, a vault with Bases disabled, and the
 * duplicate-registration case that would otherwise show the user a Notice on
 * every plugin reload.
 */

import type { Plugin } from 'obsidian';
import {
    ensureAnalyzeViewRegistered,
    isAnalyzeViewRegistered,
    resetAnalyzeViewRegistrationRecord,
    supportsBasesViews,
    NEXUS_ANALYZE_VIEW_ID
} from '@/agents/baseManager/services/basesAvailability';

function pluginWith(registerBasesView?: jest.Mock): Plugin {
    return (registerBasesView ? { registerBasesView } : {}) as unknown as Plugin;
}

beforeEach(() => {
    resetAnalyzeViewRegistrationRecord();
});

afterAll(() => {
    resetAnalyzeViewRegistrationRecord();
});

describe('ensureAnalyzeViewRegistered', () => {
    it('returns false on an app with no Bases view API (older than 1.10.0)', () => {
        const plugin = pluginWith();
        expect(supportsBasesViews(plugin)).toBe(false);
        expect(ensureAnalyzeViewRegistered(plugin)).toBe(false);
        expect(isAnalyzeViewRegistered()).toBe(false);
    });

    it('returns false when Bases is disabled in the vault', () => {
        const register = jest.fn().mockReturnValue(false);
        expect(ensureAnalyzeViewRegistered(pluginWith(register))).toBe(false);
        expect(register).toHaveBeenCalledTimes(1);
        expect(isAnalyzeViewRegistered()).toBe(false);
    });

    it('registers the headless nexus-analyze view when Bases is enabled', () => {
        const register = jest.fn().mockReturnValue(true);
        expect(ensureAnalyzeViewRegistered(pluginWith(register))).toBe(true);

        expect(register).toHaveBeenCalledTimes(1);
        const [viewId, registration] = register.mock.calls[0] as [string, { name: string; factory: unknown }];
        expect(viewId).toBe(NEXUS_ANALYZE_VIEW_ID);
        expect(typeof registration.factory).toBe('function');
        expect(isAnalyzeViewRegistered()).toBe(true);
    });

    it('does not register twice in one app process (a duplicate shows the user a Notice)', () => {
        const register = jest.fn().mockReturnValue(true);
        expect(ensureAnalyzeViewRegistered(pluginWith(register))).toBe(true);

        // Second call stands in for a plugin reload: fresh module scope in
        // production, same Obsidian registration table.
        const afterReload = jest.fn().mockReturnValue(true);
        expect(ensureAnalyzeViewRegistered(pluginWith(afterReload))).toBe(true);
        expect(afterReload).not.toHaveBeenCalled();
    });

    it('re-probes after a failure, so enabling Bases then reloading works', () => {
        const disabled = jest.fn().mockReturnValue(false);
        expect(ensureAnalyzeViewRegistered(pluginWith(disabled))).toBe(false);

        const enabled = jest.fn().mockReturnValue(true);
        expect(ensureAnalyzeViewRegistered(pluginWith(enabled))).toBe(true);
        expect(enabled).toHaveBeenCalledTimes(1);
    });

    it('treats a throwing registerBasesView as unavailable rather than propagating', () => {
        const register = jest.fn().mockImplementation(() => {
            throw new Error('boom');
        });
        expect(ensureAnalyzeViewRegistered(pluginWith(register))).toBe(false);
        expect(isAnalyzeViewRegistered()).toBe(false);
    });
});

/**
 * The gate itself: the agent must be ABSENT when the probe fails, not present
 * and answering "unavailable". `AgentInitializationService` is exercised
 * directly because that is where the decision lives.
 */
describe('AgentInitializationService.initializeBaseManager', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentInitializationService } = require('@/services/agent/AgentInitializationService');

    function makeService(registerBasesView?: jest.Mock) {
        const registerAgent = jest.fn();
        const agentManager = { registerAgent } as unknown as import('@/services/AgentManager').AgentManager;
        const app = { vault: {}, metadataCache: {} } as unknown as import('obsidian').App;
        const service = new AgentInitializationService(app, pluginWith(registerBasesView), agentManager);
        return { service, registerAgent };
    }

    it('registers the agent when Bases is enabled', () => {
        const { service, registerAgent } = makeService(jest.fn().mockReturnValue(true));
        expect(service.initializeBaseManager()).toBe(true);
        expect(registerAgent).toHaveBeenCalledTimes(1);
        expect(registerAgent.mock.calls[0][0].name).toBe('baseManager');
    });

    it('registers NOTHING when Bases is disabled', () => {
        const { service, registerAgent } = makeService(jest.fn().mockReturnValue(false));
        expect(service.initializeBaseManager()).toBe(false);
        expect(registerAgent).not.toHaveBeenCalled();
    });

    it('registers NOTHING on an app without the Bases view API', () => {
        const { service, registerAgent } = makeService();
        expect(service.initializeBaseManager()).toBe(false);
        expect(registerAgent).not.toHaveBeenCalled();
    });
});
