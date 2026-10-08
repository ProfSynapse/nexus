import { BackgroundProcessor, type BackgroundProcessorConfig } from '../../src/core/background/BackgroundProcessor';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function createProcessor(getService: jest.Mock) {
  return new BackgroundProcessor({ getService } as unknown as BackgroundProcessorConfig);
}

describe('BackgroundProcessor shutdown', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('cancels deferred startup and cannot schedule another after unload', async () => {
    const getService = jest.fn().mockResolvedValue(null);
    const processor = createProcessor(getService);
    processor.startBackgroundStartupProcessing();
    await processor.shutdown();
    processor.startBackgroundStartupProcessing();
    await jest.advanceTimersByTimeAsync(3000);
    expect(getService).not.toHaveBeenCalled();
  });

  it('does not start resolved services after shutdown interrupted their lookup', async () => {
    const lookup = deferred();
    const start = jest.fn();
    const getService = jest.fn(async () => { await lookup.promise; return { start }; });
    const processor = createProcessor(getService);
    processor.startBackgroundStartupProcessing();
    jest.advanceTimersByTime(2000);
    expect(getService).toHaveBeenCalledTimes(1);
    let settled = false;
    const shutdown = processor.shutdown().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    lookup.resolve();
    await shutdown;
    expect(start).not.toHaveBeenCalled();
    expect(getService).toHaveBeenCalledTimes(1);
  });

  it('drains an already running service start and never starts the next workflow after unload', async () => {
    const running = deferred();
    const start = jest.fn(async () => running.promise);
    const getService = jest.fn().mockResolvedValue({ start });
    const processor = createProcessor(getService);
    processor.startBackgroundStartupProcessing();
    await jest.advanceTimersByTimeAsync(2000);
    expect(start).toHaveBeenCalledTimes(2);
    let settled = false;
    const shutdown = processor.shutdown().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    running.resolve();
    await shutdown;
    expect(getService.mock.calls.map(call => call[0])).toEqual(['remoteAgentRegistry', 'remoteAgentJobs']);
  });

  it('coalesces repeated requests while the initial startup timer is pending', async () => {
    const getService = jest.fn().mockResolvedValue(null);
    const processor = createProcessor(getService);
    processor.startBackgroundStartupProcessing();
    processor.startBackgroundStartupProcessing();
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(2000);
    expect(getService).toHaveBeenCalledTimes(3);
  });
});
