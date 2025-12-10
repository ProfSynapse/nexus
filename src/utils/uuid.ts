/**
 * Mobile-compatible UUID generator
 *
 * MOBILE COMPATIBILITY (Dec 2025):
 * The 'uuid' npm package uses crypto.randomUUID() which may not be available
 * in all mobile environments. This provides a fallback implementation.
 *
 * Priority:
 * 1. crypto.randomUUID() - Modern browsers and Node.js 19+
 * 2. crypto.getRandomValues() - Web Crypto API fallback
 * 3. Math.random() - Last resort fallback (not cryptographically secure)
 */

/**
 * Generate a UUID v4 compatible with mobile platforms
 */
export function generateUUID(): string {
  // Try native randomUUID first (fastest and most secure)
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  // Fall back to Web Crypto API getRandomValues
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);

    // Set version (4) and variant (RFC4122)
    bytes[6] = (bytes[6] & 0x0f) | 0x40;  // Version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80;  // Variant RFC4122

    // Convert to hex string
    const hex = Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Last resort: Math.random() based UUID (not cryptographically secure)
  // This should rarely if ever be needed, but provides ultimate fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Alias for compatibility with uuid package API
export const v4 = generateUUID;
