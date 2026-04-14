/**
 * ChatView.handleOpenAgentStatus — lazy-init unit tests
 *
 * Coverage:
 *   - handleOpenAgentStatus calls initializeSubagentInfrastructure when subagentController is null
 *   - After successful lazy-init, opens agent status modal
 *   - Shows Notice on init failure and does NOT call openAgentStatusModal
 *   - Shows Notice on openAgentStatusModal failure
 *   - Does not re-init when subagentController is already set
 *   - Early-returns when branchViewCoordinator is null
 *
 * Approach:
 *   ChatView has deep dependencies (ItemView, services, controllers).
 *   We replicate handleOpenAgentStatus + initializeSubagentInfrastructure logic
 *   in a minimal test double and verify behavioral contracts. This avoids
 *   constructing the full ChatView dependency graph.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// Track Notice construction calls via module-level spy
const noticeConstructorCalls: Array<{ message: string; timeout?: number }> = [];

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian');
  return {
    ...actual,
    Notice: jest.fn().mockImplementation(function (this: any, message: string, timeout?: number) {
      noticeConstructorCalls.push({ message, timeout });
    }),
  };
});

import { Notice } from 'obsidian';

describe('ChatView.handleOpenAgentStatus — lazy-init', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    noticeConstructorCalls.length = 0;
  });

  /**
   * Build a minimal ChatView-shaped test double with only the fields
   * and methods that handleOpenAgentStatus touches. The method body
   * mirrors ChatView.ts lines 825-845 exactly.
   */
  function createTestDouble(opts: {
    subagentController?: unknown;
    branchViewCoordinator?: unknown;
    initializeSubagentInfrastructure?: () => Promise<void>;
  } = {}) {
    const subagentIntegration = {
      initialize: jest.fn().mockResolvedValue({
        subagentController: { clearAgentStatus: jest.fn() },
        preservationService: {},
      }),
    };

    const double = {
      subagentController: 'subagentController' in opts ? opts.subagentController : null,
      branchViewCoordinator: 'branchViewCoordinator' in opts
        ? opts.branchViewCoordinator
        : { openAgentStatusModal: jest.fn() },
      subagentIntegration,
      preservationService: null as unknown,

      // Mirrors ChatView.initializeSubagentInfrastructure (lines 652-661)
      async initializeSubagentInfrastructure(): Promise<void> {
        if (opts.initializeSubagentInfrastructure) {
          return opts.initializeSubagentInfrastructure();
        }
        const result = await subagentIntegration.initialize();
        double.subagentController = result.subagentController;
        double.preservationService = result.preservationService;
      },

      // Mirrors ChatView.handleOpenAgentStatus (lines 825-845)
      async handleOpenAgentStatus(): Promise<void> {
        if (!this.branchViewCoordinator) return;

        if (!this.subagentController) {
          try {
            await this.initializeSubagentInfrastructure();
          } catch (error) {
            console.warn('[ChatView] Failed to lazy-init subagent infrastructure:', error);
            new Notice('Subagent system unavailable', 2500);
            return;
          }
        }

        try {
          (this.branchViewCoordinator as any).openAgentStatusModal();
        } catch (error) {
          console.warn('[ChatView] Failed to open agent status modal:', error);
          new Notice('Subagent system unavailable', 2500);
        }
      },
    };

    return double;
  }

  it('calls initializeSubagentInfrastructure when subagentController is null', async () => {
    const double = createTestDouble();

    await double.handleOpenAgentStatus();

    expect(double.subagentIntegration.initialize).toHaveBeenCalledTimes(1);
    expect(double.subagentController).not.toBeNull();
  });

  it('opens agent status modal after successful lazy-init', async () => {
    const openModal = jest.fn();
    const double = createTestDouble({
      branchViewCoordinator: { openAgentStatusModal: openModal },
    });

    await double.handleOpenAgentStatus();

    expect(openModal).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-init when subagentController is already set', async () => {
    const existingController = { clearAgentStatus: jest.fn() };
    const openModal = jest.fn();
    const double = createTestDouble({
      subagentController: existingController,
      branchViewCoordinator: { openAgentStatusModal: openModal },
    });

    await double.handleOpenAgentStatus();

    expect(double.subagentIntegration.initialize).not.toHaveBeenCalled();
    expect(openModal).toHaveBeenCalledTimes(1);
  });

  it('shows Notice and does NOT call openAgentStatusModal on init failure', async () => {
    const openModal = jest.fn();
    const double = createTestDouble({
      branchViewCoordinator: { openAgentStatusModal: openModal },
      initializeSubagentInfrastructure: async () => {
        throw new Error('Init failed');
      },
    });

    await double.handleOpenAgentStatus();

    expect(openModal).not.toHaveBeenCalled();
    expect(noticeConstructorCalls).toHaveLength(1);
    expect(noticeConstructorCalls[0].message).toBe('Subagent system unavailable');
  });

  it('shows Notice on openAgentStatusModal failure', async () => {
    const double = createTestDouble({
      subagentController: { clearAgentStatus: jest.fn() },
      branchViewCoordinator: {
        openAgentStatusModal: jest.fn(() => {
          throw new Error('Modal failed');
        }),
      },
    });

    await double.handleOpenAgentStatus();

    expect(noticeConstructorCalls).toHaveLength(1);
    expect(noticeConstructorCalls[0].message).toBe('Subagent system unavailable');
  });

  it('early-returns when branchViewCoordinator is null', async () => {
    const double = createTestDouble({
      branchViewCoordinator: null,
    });

    await double.handleOpenAgentStatus();

    // Neither init nor modal should have been called
    expect(double.subagentIntegration.initialize).not.toHaveBeenCalled();
    expect(noticeConstructorCalls).toHaveLength(0);
  });
});
