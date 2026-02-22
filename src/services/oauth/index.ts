/**
 * OAuth Service Barrel Export
 * Location: src/services/oauth/index.ts
 *
 * Re-exports all OAuth service types, utilities, and providers for
 * convenient importing from a single path.
 */

export type {
  OAuthProviderConfig,
  OAuthResult,
  IOAuthProvider,
  OAuthState,
} from './IOAuthProvider';

export {
  base64url,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
} from './PKCEUtils';

export type {
  CallbackResult,
  CallbackServerHandle,
  CallbackServerOptions,
} from './OAuthCallbackServer';
export { startCallbackServer } from './OAuthCallbackServer';

export type { OAuthFlowState } from './OAuthService';
export { OAuthService } from './OAuthService';

export { OpenRouterOAuthProvider } from './providers/OpenRouterOAuthProvider';
export { OpenAICodexOAuthProvider } from './providers/OpenAICodexOAuthProvider';
