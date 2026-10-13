/** JSON settings merge: only local changes since the baseline override incoming values. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function cloneSettings<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

export function settingsEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => settingsEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.prototype.hasOwnProperty.call(right, key) && settingsEqual(left[key], right[key]));
}

/** Objects merge recursively; arrays/scalars are atomic and an explicit local deletion wins. */
export function mergeSettingsChanges<T>(baseline: T, local: T, incoming: T): T {
  if (settingsEqual(baseline, local)) return cloneSettings(incoming);
  if (isRecord(local) && (isRecord(baseline) || baseline === undefined) && (isRecord(incoming) || incoming === undefined)) {
    const before: Record<string, unknown> = isRecord(baseline) ? baseline : {};
    const latest: Record<string, unknown> = isRecord(incoming) ? incoming : {};
    const merged = cloneSettings(latest);
    for (const key of new Set([...Object.keys(before), ...Object.keys(local)])) {
      if (!Object.prototype.hasOwnProperty.call(local, key)) {
        if (Object.prototype.hasOwnProperty.call(before, key)) delete merged[key];
      } else {
        const previous = Object.prototype.hasOwnProperty.call(before, key) ? before[key] : undefined;
        if (settingsEqual(previous, local[key])) continue;
        const remote = Object.prototype.hasOwnProperty.call(latest, key) ? latest[key] : undefined;
        Object.defineProperty(merged, key, {
          value: mergeSettingsChanges(previous, local[key], remote),
          enumerable: true, configurable: true, writable: true,
        });
      }
    }
    return merged as T;
  }
  return cloneSettings(local);
}

/** Keep retained provider/settings object references live while adopting remote changes. */
export function reconcileSettingsInPlace<T extends object>(target: T, next: T): void {
  const destination = target as Record<string, unknown>;
  const source = next as Record<string, unknown>;
  for (const key of Object.keys(destination)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) delete destination[key];
  }
  for (const key of Object.keys(source)) {
    if (Object.prototype.hasOwnProperty.call(destination, key) && isRecord(destination[key]) && isRecord(source[key])) {
      reconcileSettingsInPlace(destination[key], source[key]);
    } else if (!settingsEqual(destination[key], source[key])) {
      Object.defineProperty(destination, key, {
        value: cloneSettings(source[key]), enumerable: true, configurable: true, writable: true,
      });
    }
  }
}
