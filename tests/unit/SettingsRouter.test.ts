/**
 * SettingsRouter Unit Tests
 *
 * Full state machine coverage for navigation router.
 * No DOM mocking needed — pure state management testing.
 *
 * Coverage target: 95%+ (state machine, STANDARD risk)
 */

import { SettingsRouter, SettingsTab, RouterState } from '../../src/settings/SettingsRouter';

// ============================================================================
// Initial State
// ============================================================================

describe('SettingsRouter', () => {
  type MutableRouterState = RouterState & { tab: string };

  let router: SettingsRouter;

  beforeEach(() => {
    router = new SettingsRouter();
  });

  // --------------------------------------------------------------------------
  // Initial state
  // --------------------------------------------------------------------------

  describe('initial state', () => {
    it('should start with defaults tab', () => {
      const state = router.getState();
      expect(state.tab).toBe('defaults');
    });

    it('should start with list view', () => {
      const state = router.getState();
      expect(state.view).toBe('list');
    });

    it('should start with no detailId', () => {
      const state = router.getState();
      expect(state.detailId).toBeUndefined();
    });

    it('should not be in detail view initially', () => {
      expect(router.isDetailView()).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // setTab()
  // --------------------------------------------------------------------------

  describe('setTab()', () => {
    it('should switch to the specified tab', () => {
      router.setTab('workspaces');
      expect(router.getState().tab).toBe('workspaces');
    });

    it('should reset view to list when switching tabs', () => {
      router.showDetail('ws-1');
      expect(router.getState().view).toBe('detail');

      router.setTab('providers');
      expect(router.getState().view).toBe('list');
    });

    it('should clear detailId when switching tabs', () => {
      router.showDetail('ws-1');
      expect(router.getState().detailId).toBe('ws-1');

      router.setTab('prompts');
      expect(router.getState().detailId).toBeUndefined();
    });

    it('should accept all valid tab values', () => {
      const tabs: SettingsTab[] = ['defaults', 'workspaces', 'prompts', 'providers', 'apps', 'data'];
      for (const tab of tabs) {
        router.setTab(tab);
        expect(router.getState().tab).toBe(tab);
      }
    });

    it('should allow setting the same tab again', () => {
      router.setTab('workspaces');
      router.setTab('workspaces');
      expect(router.getState().tab).toBe('workspaces');
    });
  });

  // --------------------------------------------------------------------------
  // showDetail()
  // --------------------------------------------------------------------------

  describe('showDetail()', () => {
    it('should set view to detail', () => {
      router.showDetail('item-1');
      expect(router.getState().view).toBe('detail');
    });

    it('should set the detailId', () => {
      router.showDetail('item-42');
      expect(router.getState().detailId).toBe('item-42');
    });

    it('should preserve the current tab', () => {
      router.setTab('providers');
      router.showDetail('provider-1');
      expect(router.getState().tab).toBe('providers');
    });

    it('should report isDetailView as true', () => {
      router.showDetail('item-1');
      expect(router.isDetailView()).toBe(true);
    });

    it('should allow navigating to a different detail from detail view', () => {
      router.showDetail('item-1');
      router.showDetail('item-2');
      expect(router.getState().detailId).toBe('item-2');
      expect(router.getState().view).toBe('detail');
    });

    it('should handle empty string as detailId', () => {
      router.showDetail('');
      expect(router.getState().detailId).toBe('');
      expect(router.getState().view).toBe('detail');
    });
  });

  // --------------------------------------------------------------------------
  // back()
  // --------------------------------------------------------------------------

  describe('back()', () => {
    it('should return to list view from detail view', () => {
      router.showDetail('item-1');
      router.back();
      expect(router.getState().view).toBe('list');
    });

    it('should clear the detailId', () => {
      router.showDetail('item-1');
      router.back();
      expect(router.getState().detailId).toBeUndefined();
    });

    it('should preserve the current tab', () => {
      router.setTab('apps');
      router.showDetail('app-1');
      router.back();
      expect(router.getState().tab).toBe('apps');
    });

    it('should be safe to call when already in list view', () => {
      // Should not throw or corrupt state
      router.back();
      expect(router.getState().view).toBe('list');
      expect(router.getState().tab).toBe('defaults');
    });
  });

  // --------------------------------------------------------------------------
  // isDetailView()
  // --------------------------------------------------------------------------

  describe('isDetailView()', () => {
    it('should return false in list view', () => {
      expect(router.isDetailView()).toBe(false);
    });

    it('should return true in detail view', () => {
      router.showDetail('x');
      expect(router.isDetailView()).toBe(true);
    });

    it('should return false after back()', () => {
      router.showDetail('x');
      router.back();
      expect(router.isDetailView()).toBe(false);
    });

    it('should return false after setTab() from detail view', () => {
      router.showDetail('x');
      router.setTab('data');
      expect(router.isDetailView()).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // onNavigate() — listener lifecycle
  // --------------------------------------------------------------------------

  describe('onNavigate()', () => {
    it('should call listener when tab changes', () => {
      const listener = jest.fn();
      router.onNavigate(listener);

      router.setTab('providers');
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ tab: 'providers', view: 'list' })
      );
    });

    it('should call listener when showing detail', () => {
      const listener = jest.fn();
      router.onNavigate(listener);

      router.showDetail('ws-1');
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ view: 'detail', detailId: 'ws-1' })
      );
    });

    it('should call listener when going back', () => {
      router.showDetail('ws-1');
      const listener = jest.fn();
      router.onNavigate(listener);

      router.back();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ view: 'list', detailId: undefined })
      );
    });

    it('should support multiple listeners', () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();
      router.onNavigate(listener1);
      router.onNavigate(listener2);

      router.setTab('apps');
      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it('should return an unsubscribe function', () => {
      const listener = jest.fn();
      const unsubscribe = router.onNavigate(listener);

      router.setTab('apps');
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      router.setTab('data');
      expect(listener).toHaveBeenCalledTimes(1); // Not called again
    });

    it('should not affect other listeners when one unsubscribes', () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();
      const unsub1 = router.onNavigate(listener1);
      router.onNavigate(listener2);

      unsub1();
      router.setTab('prompts');

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it('should be safe to unsubscribe the same listener twice', () => {
      const listener = jest.fn();
      const unsubscribe = router.onNavigate(listener);
      unsubscribe();
      expect(() => unsubscribe()).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // destroy()
  // --------------------------------------------------------------------------

  describe('destroy()', () => {
    it('should remove all listeners', () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();
      router.onNavigate(listener1);
      router.onNavigate(listener2);

      router.destroy();
      router.setTab('data');

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
    });

    it('should be safe to call destroy multiple times', () => {
      router.destroy();
      expect(() => router.destroy()).not.toThrow();
    });

    it('should still allow state changes after destroy', () => {
      router.destroy();
      router.setTab('workspaces');
      expect(router.getState().tab).toBe('workspaces');
    });

    it('should allow new listeners after destroy', () => {
      router.destroy();
      const listener = jest.fn();
      router.onNavigate(listener);
      router.setTab('apps');
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // State immutability
  // --------------------------------------------------------------------------

  describe('state immutability', () => {
    it('should return a copy of state, not a reference', () => {
      const state1 = router.getState();
      const state2 = router.getState();
      expect(state1).toEqual(state2);
      expect(state1).not.toBe(state2);
    });

    it('should not be affected by external mutation of returned state', () => {
      const state = router.getState() as MutableRouterState;
      state.tab = 'hacked';
      expect(router.getState().tab).toBe('defaults');
    });

    it('should pass a copy to listeners', () => {
      let receivedState: RouterState | null = null;
      router.onNavigate(state => { receivedState = state; });
      router.setTab('providers');

      // Mutate the received state
      (receivedState as MutableRouterState).tab = 'hacked';
      expect(router.getState().tab).toBe('providers');
    });
  });

  // --------------------------------------------------------------------------
  // Complex navigation sequences
  // --------------------------------------------------------------------------

  describe('complex navigation sequences', () => {
    it('should handle tab → detail → back → different tab → detail correctly', () => {
      router.setTab('workspaces');
      router.showDetail('ws-1');
      router.back();
      router.setTab('providers');
      router.showDetail('prov-1');

      const state = router.getState();
      expect(state.tab).toBe('providers');
      expect(state.view).toBe('detail');
      expect(state.detailId).toBe('prov-1');
    });

    it('should notify listener for each navigation in a sequence', () => {
      const listener = jest.fn();
      router.onNavigate(listener);

      router.setTab('workspaces');    // 1
      router.showDetail('ws-1');      // 2
      router.back();                  // 3
      router.setTab('providers');     // 4

      expect(listener).toHaveBeenCalledTimes(4);
    });
  });
});
