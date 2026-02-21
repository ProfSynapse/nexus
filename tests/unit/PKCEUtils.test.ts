/**
 * PKCEUtils Unit Tests
 *
 * Tests PKCE (RFC 7636) cryptographic operations:
 * - base64url encoding
 * - Code verifier generation
 * - Code challenge (S256) derivation
 * - State parameter generation
 */

import {
  base64url,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
} from '../../src/services/oauth/PKCEUtils';

describe('PKCEUtils', () => {
  describe('base64url', () => {
    it('should encode an empty buffer', () => {
      const result = base64url(new Uint8Array(0));
      expect(result).toBe('');
    });

    it('should produce URL-safe output (no +, /, or = padding)', () => {
      // Use bytes that would produce +, /, and = in standard base64
      const buffer = new Uint8Array([251, 255, 254, 63, 62]);
      const encoded = base64url(buffer);
      expect(encoded).not.toContain('+');
      expect(encoded).not.toContain('/');
      expect(encoded).not.toContain('=');
    });

    it('should replace + with -', () => {
      // 0xFB 0xEF => standard base64 "u+8" which contains +
      const buffer = new Uint8Array([251, 239]);
      const encoded = base64url(buffer);
      expect(encoded).toContain('-');
      expect(encoded).not.toContain('+');
    });

    it('should replace / with _', () => {
      // 0xFF 0xFF => standard base64 "//8" which contains /
      const buffer = new Uint8Array([255, 255]);
      const encoded = base64url(buffer);
      expect(encoded).toContain('_');
      expect(encoded).not.toContain('/');
    });

    it('should strip trailing = padding', () => {
      // Single byte produces 2 base64 chars + 2 padding chars
      const buffer = new Uint8Array([65]); // 'A' in ASCII
      const encoded = base64url(buffer);
      expect(encoded).not.toMatch(/=$/);
    });

    it('should accept ArrayBuffer as input', () => {
      const arrayBuffer = new Uint8Array([72, 101, 108, 108, 111]).buffer;
      const encoded = base64url(arrayBuffer);
      expect(encoded).toBe('SGVsbG8'); // base64url of "Hello"
    });

    it('should accept Uint8Array as input', () => {
      const uint8 = new Uint8Array([72, 101, 108, 108, 111]);
      const encoded = base64url(uint8);
      expect(encoded).toBe('SGVsbG8'); // base64url of "Hello"
    });

    it('should produce consistent output for same input', () => {
      const buffer = new Uint8Array([1, 2, 3, 4, 5]);
      const first = base64url(buffer);
      const second = base64url(buffer);
      expect(first).toBe(second);
    });
  });

  describe('generateCodeVerifier', () => {
    it('should produce a 43-character string', () => {
      const verifier = generateCodeVerifier();
      expect(verifier).toHaveLength(43);
    });

    it('should only contain unreserved URI characters (A-Z, a-z, 0-9, -, ., _, ~)', () => {
      const verifier = generateCodeVerifier();
      expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    });

    it('should produce unique values on successive calls', () => {
      const verifiers = new Set<string>();
      for (let i = 0; i < 20; i++) {
        verifiers.add(generateCodeVerifier());
      }
      // All 20 should be unique (collision probability is astronomically low)
      expect(verifiers.size).toBe(20);
    });

    it('should use the full character set over many generations', () => {
      // Generate many verifiers and check we see a good spread
      const allChars = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const v = generateCodeVerifier();
        for (const ch of v) {
          allChars.add(ch);
        }
      }
      // We should see letters, digits, and at least some special chars
      expect(allChars.size).toBeGreaterThan(30);
    });
  });

  describe('generateCodeChallenge', () => {
    it('should produce a non-empty string', async () => {
      const verifier = generateCodeVerifier();
      const challenge = await generateCodeChallenge(verifier);
      expect(challenge.length).toBeGreaterThan(0);
    });

    it('should produce base64url-encoded output', async () => {
      const verifier = generateCodeVerifier();
      const challenge = await generateCodeChallenge(verifier);
      expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    });

    it('should be deterministic for the same verifier', async () => {
      const verifier = 'fixed-test-verifier-value-that-is-long-en';
      const challenge1 = await generateCodeChallenge(verifier);
      const challenge2 = await generateCodeChallenge(verifier);
      expect(challenge1).toBe(challenge2);
    });

    it('should produce different challenges for different verifiers', async () => {
      const v1 = generateCodeVerifier();
      const v2 = generateCodeVerifier();
      const c1 = await generateCodeChallenge(v1);
      const c2 = await generateCodeChallenge(v2);
      expect(c1).not.toBe(c2);
    });

    it('should produce a 43-character challenge (SHA-256 = 32 bytes => 43 base64url chars)', async () => {
      const verifier = generateCodeVerifier();
      const challenge = await generateCodeChallenge(verifier);
      expect(challenge).toHaveLength(43);
    });
  });

  describe('generateState', () => {
    it('should produce a non-empty string', () => {
      const state = generateState();
      expect(state.length).toBeGreaterThan(0);
    });

    it('should produce base64url-encoded output', () => {
      const state = generateState();
      expect(state).toMatch(/^[A-Za-z0-9\-_]+$/);
    });

    it('should produce approximately 43 characters (32 bytes base64url)', () => {
      const state = generateState();
      expect(state).toHaveLength(43);
    });

    it('should produce unique values on successive calls', () => {
      const states = new Set<string>();
      for (let i = 0; i < 20; i++) {
        states.add(generateState());
      }
      expect(states.size).toBe(20);
    });
  });
});
