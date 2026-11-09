/**
 * Client access domain types.
 *
 * An administrator can create credential pairs (access ID + password) linked
 * to exactly one GitHub repository. Clients sign in with those credentials
 * and can only edit the locked repository. The admin's GitHub token is stored
 * encrypted server-side; clients never interact with GitHub directly.
 */

import type { RepoRef } from './auth';

/** A client access record as returned to the admin (never includes secrets). */
export interface ClientAccess {
  clientId: string;
  label: string;
  repo: RepoRef;
  /** Admin login that created it. */
  createdBy: string;
  /** ISO timestamp. */
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
  /** Preferred UI language for this client ('en' | 'fr'); undefined = browser default. */
  language?: 'en' | 'fr';
  /**
   * Review mode: when true, this client's saves go to a `cms/<clientId>`
   * branch and open a pull request instead of committing to the production
   * branch. The admin approves by merging. Undefined/false on legacy records
   * (direct saves) — backward compatible by absence.
   */
  requireApproval?: boolean;
}

/** Returned once on create / password reset — the plaintext password is never retrievable afterwards. */
export interface ClientAccessCreated {
  access: ClientAccess;
  password: string;
}
