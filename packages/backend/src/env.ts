/**
 * Typed Worker environment.
 *
 * Declares the runtime bindings available to the Cloudflare
 * Worker: public vars, secret vars, and KV namespaces.
 *
 * SECURITY MODEL: GitHub credentials are secrets. They are bound only to
 * the Worker and are never sent to the frontend.
 */

/** Runtime environment for the CMS Worker. */
export interface Env {
  /** KV namespace storing session tokens and settings. */
  SESSION_KV: KVNamespace;

  /** Static assets binding serving the built frontend. */
  ASSETS: Fetcher;

  /** GitHub OAuth client ID (public by design). */
  GITHUB_CLIENT_ID: string;

  /** GitHub OAuth redirect URI targeting the frontend. */
  GITHUB_REDIRECT_URI: string;

  /** GitHub OAuth client secret. SECRET — never exposed. */
  GITHUB_CLIENT_SECRET: string;

  /** AES-256 key (base64 or hex) used to encrypt GitHub tokens at rest in KV. SECRET. */
  SESSION_ENCRYPTION_KEY: string;

  /** Cloudflare OAuth client id (public). Optional — empty disables the Cloudflare login. */
  CLOUDFLARE_OAUTH_CLIENT_ID: string;

  /** Cloudflare OAuth client secret. SECRET — never exposed. */
  CLOUDFLARE_OAUTH_CLIENT_SECRET: string;

  /** Registered Cloudflare OAuth callback URL (public). */
  CLOUDFLARE_OAUTH_REDIRECT_URI: string;

  /** Vercel OAuth client id (public). Optional — empty disables the Vercel login. */
  VERCEL_OAUTH_CLIENT_ID: string;

  /** Vercel OAuth client secret. SECRET (Vercel also mandates PKCE on top). */
  VERCEL_OAUTH_CLIENT_SECRET: string;

  /** Registered Vercel OAuth callback URL (public). */
  VERCEL_OAUTH_REDIRECT_URI: string;

  /** Comma-separated list of frontend origins allowed for credentialed CORS. Public. */
  ALLOWED_ORIGINS: string;

  /**
   * GitHub login pinned as this instance's operator (public, optional —
   * empty means the first GitHub login claims the slot, write-once in KV).
   * Any other GitHub login is rejected at exchange with 403 instance_locked.
   */
  OPERATOR_LOGIN: string;
}