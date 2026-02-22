/**
 * PKCEUtils.ts
 * Location: src/services/oauth/PKCEUtils.ts
 *
 * Standalone pure functions for OAuth 2.0 PKCE (RFC 7636) cryptographic
 * operations. All randomness uses crypto.getRandomValues() -- never
 * Math.random(). Challenge method is always S256 (SHA-256).
 *
 * Exported as standalone functions (not class methods) for testability.
 *
 * Used by: OAuthService.ts (generates PKCE pairs before each OAuth flow)
 * Tested by: tests/services/oauth/PKCEUtils.test.ts
 */

/**
 * Base64url-encode a buffer. Produces URL-safe output with no padding,
 * per RFC 7636 Appendix A.
 */
export function base64url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Generate a cryptographically random PKCE code verifier.
 * Produces a 43-character string from the unreserved URI character set
 * (A-Z, a-z, 0-9, -, ., _, ~) as specified in RFC 7636 Section 4.1.
 *
 * Uses crypto.getRandomValues() for secure randomness.
 */
export function generateCodeVerifier(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = new Uint8Array(43);
  crypto.getRandomValues(bytes);
  let verifier = '';
  for (let i = 0; i < bytes.length; i++) {
    verifier += chars[bytes[i] % chars.length];
  }
  return verifier;
}

/**
 * Derive a PKCE code challenge from a code verifier using the S256 method.
 * Computes SHA-256 hash of the verifier and base64url-encodes the result.
 *
 * @param verifier - The code verifier string to hash
 * @returns Base64url-encoded SHA-256 hash of the verifier
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64url(hash);
}

/**
 * Generate a cryptographically random state parameter for CSRF protection.
 * Produces a 32-byte random value, base64url-encoded (~43 characters).
 *
 * Uses crypto.getRandomValues() for secure randomness.
 */
export function generateState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}
