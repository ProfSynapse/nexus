/**
 * DeviceFlowCancellation.ts
 * Location: src/services/oauth/DeviceFlowCancellation.ts
 *
 * Cancellation helpers for device-code OAuth flows, which poll for minutes and
 * must stop as soon as the provider modal that started them closes.
 *
 * Used by: OpenAICodexDeviceAuth, GithubCopilotOAuthProvider
 */

/** Throw when the flow has been cancelled. */
export function throwIfAborted(signal: AbortSignal | undefined, message = 'Device login cancelled'): void {
  if (signal?.aborted) throw new Error(message);
}

/** Wait between polls; resolves early when `signal` aborts. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = window.setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
