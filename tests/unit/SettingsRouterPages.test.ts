/**
 * Get started pages live in the settings router. Failure this buys: Back on
 * "Chat inside Obsidian" skipping straight to the tab list (losing the user's
 * place), or a tab click leaving a page open on top of the tab it selected.
 */
import { SettingsRouter } from '../../src/settings/SettingsRouter';

describe('SettingsRouter pages', () => {
  it('goes back one level at a time: a setup page, then Get started, then the tab list', () => {
    const router = new SettingsRouter();
    router.setTab('apps');
    router.openPage('get-started');
    router.openPage('get-started-chat');

    router.back();
    expect(router.getState()).toEqual(expect.objectContaining({ page: 'get-started', tab: 'apps' }));

    router.back();
    expect(router.getState().page).toBeUndefined();
    expect(router.getState().tab).toBe('apps');
    expect(router.isPageOpen()).toBe(false);
  });

  it('goes from the external agent page back to Get started', () => {
    const router = new SettingsRouter();
    router.openPage('get-started-agents');
    router.back();
    expect(router.getState().page).toBe('get-started');
  });

  it('closes any open page when a tab is chosen', () => {
    const router = new SettingsRouter();
    router.openPage('get-started-chat');
    router.setTab('providers');
    expect(router.getState()).toEqual(expect.objectContaining({ tab: 'providers', view: 'list', page: undefined }));
  });

  it('keeps detail navigation unchanged when no page is open', () => {
    const router = new SettingsRouter();
    router.setTab('workspaces');
    router.showDetail('ws-1');
    router.back();
    expect(router.getState()).toEqual(expect.objectContaining({ tab: 'workspaces', view: 'list', detailId: undefined }));
  });

  it('notifies listeners on every page move and honours the navigation guard', () => {
    const router = new SettingsRouter();
    const seen: Array<string | undefined> = [];
    router.onNavigate(state => seen.push(state.page));
    router.openPage('get-started');
    router.closePage();
    expect(seen).toEqual(['get-started', undefined]);

    const release = router.setNavigationGuard(() => false);
    router.openPage('get-started');
    expect(router.getState().page).toBeUndefined();
    release();
  });
});
