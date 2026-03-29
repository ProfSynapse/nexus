function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function getErrorStatusSuffix(error: unknown): string {
  if (!isRecord(error)) {
    return '';
  }

  const status = error.status;
  if (typeof status === 'string' || typeof status === 'number') {
    return ` (${String(status)})`;
  }

  return '';
}

export function getErrorBody(error: unknown): string {
  if (isRecord(error)) {
    const text = error.text;
    if (typeof text === 'string') {
      return text;
    }

    const message = error.message;
    if (typeof message === 'string') {
      return message;
    }
  }

  return String(error);
}