/**
 * Auth service module.
 *
 * Server-side authentication: OAuth code exchange, session
 * management, client access credentials, and GitHub token storage.
 */

export { SESSION_TTL_SECONDS, SessionManager } from './session';
export type { SessionRecord } from './session';
export { exchangeCodeForToken } from './oauth';
export { isOperatorLogin } from './operator';
export { resolveEncryptionKey } from './crypto';
export {
  generateCodeVerifier,
  generateOAuthState,
  codeChallengeS256,
  buildAuthorizeUrl,
  exchangePlatformCode,
  refreshPlatformToken,
  fetchPlatformIdentity,
  platformOAuthClient,
} from './platformOauth';
export type { PlatformOAuthClient, PlatformTokens, PlatformIdentity } from './platformOauth';
export { PlatformOAuthError } from './platformOauth';
export { ClientStore } from './clients';
export type { ClientRecord } from './clients';
export {
  generateClientId,
  generatePassword,
  generateSalt,
  hashPassword,
  verifyPassword,
} from './password';
