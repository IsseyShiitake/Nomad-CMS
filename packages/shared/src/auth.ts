/**
 * Authentication domain types.
 *
 * The CMS authenticates with GitHub via OAuth. The Cloudflare Worker holds
 * the OAuth client secret and exchanges codes for tokens. The frontend never
 * sees the GitHub token — it only receives the user's public profile, while
 * the opaque session token is carried in an HttpOnly cookie the browser sends
 * automatically.
 */

/** The authenticated GitHub user's public profile. */
export interface UserProfile {
  /** GitHub user ID. */
  id: number;

  /** Login, e.g. "octocat". */
  login: string;

  /** Display name, if set. */
  name: string | null;

  /** Avatar URL. */
  avatarUrl: string | null;
}

/** Payload sent to the backend to exchange an OAuth code. */
export interface OAuthCodeExchange {
  /** The OAuth authorization code from GitHub. */
  code: string;

  /** The server-issued state echoed back by GitHub (validated server-side). */
  state: string;
}

/** Whether a session belongs to the administrator or to a client access. */
export type SessionKind = 'admin' | 'client';

/** A reference to a single GitHub repository. */
export interface RepoRef {
  owner: string;
  repo: string;
}

/**
 * The session information returned to the frontend after authentication.
 *
 * Admin sessions have no repository lock. Client sessions are locked to
 * exactly one repository: the backend rejects every request for any other
 * repository.
 */
export interface SessionInfo {
  user: UserProfile;
  kind: SessionKind;
  /** null for admin; set for client sessions. */
  repoLock: RepoRef | null;
  /**
   * Preferred UI language stored on the client access ('en' | 'fr'); the
   * frontend applies it on session restore. null/absent for admins and
   * accesses without a stored preference.
   */
  language?: 'en' | 'fr' | null;
}
