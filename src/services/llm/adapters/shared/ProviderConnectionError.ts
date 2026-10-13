/** Errors eligible for retry only when the transport also proves no TCP connection. */
const RETRYABLE_CONNECT_CODES = new Set(['ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED']);

export function isRetryableConnectFailure(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 3) return false;
  if ('errors' in error) {
    return Array.isArray(error.errors) && error.errors.length > 0 && error.errors.length <= 16
      && error.errors.every(child => isRetryableConnectFailure(child, depth + 1));
  }
  return 'code' in error && typeof error.code === 'string' && RETRYABLE_CONNECT_CODES.has(error.code)
    && 'syscall' in error && error.syscall === 'connect';
}

function errorCodes(error: unknown, depth = 0): string[] {
  if (!error || typeof error !== 'object' || depth > 3) return [];
  const codes = 'code' in error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(error.code)
    ? [error.code] : [];
  if ('errors' in error && Array.isArray(error.errors)) {
    for (const child of error.errors.slice(0, 16)) codes.push(...errorCodes(child, depth + 1));
  }
  return codes;
}

/** Preserve the cause, but do not expose socket addresses or arbitrary error objects. */
export class ProviderConnectionError extends Error {
  constructor(
    operation: string,
    provider: string,
    hostname: string,
    readonly cause: unknown,
    readonly safeToRetry: boolean
  ) {
    const codes = Array.from(new Set(errorCodes(cause))).slice(0, 4).join(', ');
    super(`${operation} failed for ${provider} at ${hostname}${codes ? ` (${codes})` : ''}. Check your connection and try again.`);
    this.name = 'ProviderConnectionError';
  }
}
