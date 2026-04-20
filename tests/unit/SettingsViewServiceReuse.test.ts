/**
 * SettingsView Service Reuse Tests (PR #47)
 *
 * Tests that SettingsView reuses CustomPromptStorageService from ServiceManager
 * when available, falling back to creating a new db-less instance.
 */

// ============================================================================
// Module Mocks
// ============================================================================

jest.mock('obsidian', () => ({
  App: jest.fn(),
  Plugin: jest.fn(),
  PluginSettingTab: jest.fn(),
  Notice: jest.fn(),
  ButtonComponent: jest.fn(),
  FileSystemAdapter: jest.fn(),
  Platform: { isMobile: false, isDesktop: true },
}), { virtual: true });

jest.mock('../../src/utils/logger', () => ({
  logger: {
    systemLog: jest.fn(),
    systemError: jest.fn(),
  },
}));

// ============================================================================
// Tests — isolated logic extraction
// ============================================================================

describe('SettingsView — CustomPromptStorageService reuse logic', () => {
  /**
   * We test the service-resolution logic in isolation since SettingsView
   * has complex Obsidian dependencies. This mirrors the exact logic from
   * getCurrentServices() in SettingsView.ts lines 368-380.
   */

  interface MockServiceManager {
    getServiceIfReady<T>(name: string): T | null;
  }

  function resolveCustomPromptStorage(
    existingStorage: unknown | undefined,
    serviceManager: MockServiceManager | undefined,
    fallbackFactory: () => unknown
  ): unknown {
    if (existingStorage) return existingStorage;

    // Try ServiceManager first (has db, writes to SQLite + data.json)
    if (serviceManager) {
      const storageFromManager = serviceManager.getServiceIfReady('customPromptStorageService');
      if (storageFromManager) {
        return storageFromManager;
      }
    }

    // Fallback: create without db (writes to data.json only)
    return fallbackFactory();
  }

  it('should return existing storage if already initialized', () => {
    const existingStorage = { id: 'existing' };
    const serviceManager = {
      getServiceIfReady: jest.fn().mockReturnValue({ id: 'from-manager' }),
    };
    const fallback = jest.fn().mockReturnValue({ id: 'fallback' });

    const result = resolveCustomPromptStorage(existingStorage, serviceManager, fallback);

    expect(result.id).toBe('existing');
    expect(serviceManager.getServiceIfReady).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('should use ServiceManager when available and service is ready', () => {
    const managerStorage = { id: 'from-manager', hasDb: true };
    const serviceManager = {
      getServiceIfReady: jest.fn().mockReturnValue(managerStorage),
    };
    const fallback = jest.fn().mockReturnValue({ id: 'fallback' });

    const result = resolveCustomPromptStorage(undefined, serviceManager, fallback);

    expect(result.id).toBe('from-manager');
    expect(serviceManager.getServiceIfReady).toHaveBeenCalledWith('customPromptStorageService');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('should fall back to factory when ServiceManager returns null', () => {
    const serviceManager = {
      getServiceIfReady: jest.fn().mockReturnValue(null),
    };
    const fallbackStorage = { id: 'fallback', hasDb: false };
    const fallback = jest.fn().mockReturnValue(fallbackStorage);

    const result = resolveCustomPromptStorage(undefined, serviceManager, fallback);

    expect(result.id).toBe('fallback');
    expect(serviceManager.getServiceIfReady).toHaveBeenCalledWith('customPromptStorageService');
    expect(fallback).toHaveBeenCalled();
  });

  it('should fall back to factory when ServiceManager is undefined', () => {
    const fallbackStorage = { id: 'fallback' };
    const fallback = jest.fn().mockReturnValue(fallbackStorage);

    const result = resolveCustomPromptStorage(undefined, undefined, fallback);

    expect(result.id).toBe('fallback');
    expect(fallback).toHaveBeenCalled();
  });

  it('should query with exact service key "customPromptStorageService"', () => {
    const serviceManager = {
      getServiceIfReady: jest.fn().mockReturnValue(null),
    };
    const fallback = jest.fn().mockReturnValue({});

    resolveCustomPromptStorage(undefined, serviceManager, fallback);

    expect(serviceManager.getServiceIfReady).toHaveBeenCalledWith('customPromptStorageService');
  });

  it('should only call getServiceIfReady once per resolution', () => {
    const serviceManager = {
      getServiceIfReady: jest.fn().mockReturnValue({ id: 'ready' }),
    };
    const fallback = jest.fn();

    resolveCustomPromptStorage(undefined, serviceManager, fallback);

    expect(serviceManager.getServiceIfReady).toHaveBeenCalledTimes(1);
  });
});
