import { App } from 'obsidian';
import { AppManager } from '../../src/services/apps/AppManager';

describe('AppManager', () => {
  function createManager() {
    const onRegister = jest.fn();
    const onUnregister = jest.fn();
    const manager = new AppManager(
      { apps: {} },
      onRegister,
      onUnregister,
      new App()
    );

    return { manager, onRegister, onUnregister };
  }

  it('installs apps without auto-enabling them', () => {
    const { manager, onRegister } = createManager();

    const result = manager.installApp('web-tools');

    expect(result).toEqual({ success: true });
    expect(manager.getAppsSettings().apps['web-tools']).toMatchObject({
      enabled: false,
      credentials: {},
    });
    expect(onRegister).not.toHaveBeenCalled();

    const appInfo = manager.getAvailableApps().find(app => app.id === 'web-tools');
    expect(appInfo).toMatchObject({
      installed: true,
      enabled: false,
      configured: true,
    });
  });

  it('persists credentials for disabled apps and rehydrates them for editing', () => {
    const { manager } = createManager();
    manager.installApp('elevenlabs');

    const saved = manager.setAppCredentials('elevenlabs', { apiKey: 'sk-test' });

    expect(saved).toBe(true);

    const agent = manager.getApp('elevenlabs');
    expect(agent).toBeDefined();
    expect(agent?.hasRequiredCredentials()).toBe(true);
    expect(agent?.supportsValidation()).toBe(true);

    const appInfo = manager.getAvailableApps().find(app => app.id === 'elevenlabs');
    expect(appInfo?.configured).toBe(true);
  });

  it('registers and unregisters apps when enabled state changes', () => {
    const { manager, onRegister, onUnregister } = createManager();
    manager.installApp('elevenlabs');
    manager.setAppCredentials('elevenlabs', { apiKey: 'sk-test' });

    const enabled = manager.setAppEnabled('elevenlabs', true);
    expect(enabled).toBe(true);
    expect(onRegister).toHaveBeenCalledTimes(1);

    const disabled = manager.setAppEnabled('elevenlabs', false);
    expect(disabled).toBe(true);
    expect(onUnregister).toHaveBeenCalledTimes(1);
  });

  it('uninstalls disabled apps without requiring them to be loaded', () => {
    const { manager, onUnregister } = createManager();
    manager.installApp('web-tools');

    const result = manager.uninstallApp('web-tools');

    expect(result).toEqual({ success: true });
    expect(manager.getAppsSettings().apps['web-tools']).toBeUndefined();
    expect(onUnregister).not.toHaveBeenCalled();
  });

  it('uses app-specific validation capabilities', () => {
    const { manager } = createManager();
    manager.installApp('web-tools');
    manager.installApp('composer');
    manager.installApp('elevenlabs');

    expect(manager.getApp('web-tools')?.supportsValidation()).toBe(false);
    expect(manager.getApp('composer')?.supportsValidation()).toBe(false);
    expect(manager.getApp('elevenlabs')?.supportsValidation()).toBe(true);
    expect(manager.getApp('elevenlabs')?.getValidationActionLabel()).toBe('Validate access');
  });
});
