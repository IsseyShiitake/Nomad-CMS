/**
 * Client access management routes (admin only).
 *
 * Lets the administrator create credential pairs (access ID + password)
 * linked to exactly one repository, reset passwords, revoke, and delete
 * accesses. The admin's own GitHub token is stored encrypted in each
 * record so client sessions can act on that repository without the
 * client ever touching GitHub.
 *
 * Endpoints (all under /api/clients):
 *   GET    /                    — list accesses (secrets stripped)
 *   POST   /                    — create an access (returns one-time password)
 *   POST   /:id/reset-password  — reset a password (returns one-time password)
 *   POST   /:id/revoke          — revoke an access
 *   POST   /:id/language        — set the preferred UI language ('en' | 'fr')
 *   DELETE /:id                 — permanently delete an access
 */

import type { ClientAccessCreated } from '@cms/shared';
import { json, jsonError, readSessionToken } from '../core/http';
import { isValidOwnerRepo } from '../services/github';
import {
  ClientStore,
  SessionManager,
  generateClientId,
  generatePassword,
  generateSalt,
  hashPassword,
  resolveEncryptionKey,
} from '../services/auth';
import type { ClientRecord } from '../services/auth';
import type { RouteContext } from './index';

/** Maximum client label length. */
const MAX_LABEL_LENGTH = 60;

/** Resolves the session and enforces the admin-only guard. */
async function requireAdmin(
  request: Request,
  ctx: RouteContext,
): Promise<{ token: string; login: string; githubToken: string } | Response> {
  const token = readSessionToken(request);
  if (!token) return jsonError('unauthorized', 'Not authenticated', 401);

  const sessions = new SessionManager(ctx.env.SESSION_KV, await resolveEncryptionKey(ctx.env));
  const session = await sessions.getSession(token);
  if (!session) return jsonError('unauthorized', 'Not authenticated', 401);
  if ((session.kind ?? 'admin') !== 'admin') {
    return jsonError('admin_only', 'Only administrators can manage client access', 403);
  }
  return { token, login: session.user.login, githubToken: session.githubToken };
}

/** Route handler for /api/clients/*. */
export const clientsRoutes = {
  async handle(path: string, request: Request, ctx: RouteContext): Promise<Response> {
    const admin = await requireAdmin(request, ctx);
    if (admin instanceof Response) return admin;

    const store = new ClientStore(ctx.env.SESSION_KV, await resolveEncryptionKey(ctx.env));
    const segments = path.split('/').filter(Boolean);

    // GET / — list all accesses.
    if (segments.length === 0 && request.method === 'GET') {
      const records = await store.list();
      return json(records.map((record) => store.toAccess(record)));
    }

    // POST / — create a new access.
    if (segments.length === 0 && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as {
        repoOwner?: unknown;
        repoName?: unknown;
        label?: unknown;
        language?: unknown;
      } | null;
      const repoOwner = typeof body?.repoOwner === 'string' ? body.repoOwner.trim() : '';
      const repoName = typeof body?.repoName === 'string' ? body.repoName.trim() : '';
      const label = typeof body?.label === 'string' ? body.label.trim() : '';

      if (!repoOwner || !repoName || !label) {
        return jsonError('invalid_input', 'repoOwner, repoName and label are required', 400);
      }
      // The virtual "vercel/<project>" namespace is admin-only (its routes
      // resolve through the admin's Vercel connection and 404 for client
      // sessions) — a client access locked to it could never load anything.
      if (repoOwner === 'vercel') {
        return jsonError(
          'invalid_input',
          'Vercel direct projects cannot be assigned to a client access',
          400,
        );
      }
      // Owner/repo are interpolated into upstream GitHub URLs on every
      // request the client session makes; reject anything that could
      // reshape them.
      if (!isValidOwnerRepo(repoOwner, repoName)) {
        return jsonError('invalid_input', 'Invalid repository reference', 400);
      }
      if (label.length > MAX_LABEL_LENGTH) {
        return jsonError('invalid_input', `Label must be ${MAX_LABEL_LENGTH} characters or fewer`, 400);
      }
      // ':' and '/' would collide with the KV key layout used by deploy
      // connections ("deploy:<login>:<platform>") and the client namespace.
      if (/[:/]/.test(label)) {
        return jsonError('invalid_input', 'Label must not contain ":" or "/"', 400);
      }
      let language: 'en' | 'fr' | undefined;
      if (body?.language !== undefined && body.language !== null) {
        const raw = String(body.language);
        if (raw !== 'en' && raw !== 'fr') {
          return jsonError('invalid_input', 'language must be "en" or "fr"', 400);
        }
        language = raw;
      }

      // Generate a unique access ID.
      let clientId = generateClientId(label);
      while ((await store.get(clientId)) !== null) {
        clientId = generateClientId(label);
      }

      const password = generatePassword();
      const salt = generateSalt();
      const record: ClientRecord = {
        clientId,
        label,
        repo: { owner: repoOwner, repo: repoName },
        createdBy: admin.login,
        passwordHash: await hashPassword(password, salt),
        salt,
        githubToken: await store.encryptGitHubToken(admin.githubToken),
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        revoked: false,
        language,
        failedAttempts: 0,
        lockedUntil: null,
      };
      await store.create(record);

      const payload: ClientAccessCreated = { access: store.toAccess(record), password };
      return json(payload, 201);
    }

    // Routes below need an access ID.
    if (segments.length < 1) {
      return jsonError('not_found', 'Client route not found', 404);
    }
    let clientId: string;
    try {
      clientId = decodeURIComponent(segments[0]!);
    } catch {
      return jsonError('invalid_input', 'Malformed client id', 400);
    }

    // POST /:id/reset-password — new one-time password.
    if (segments.length === 2 && segments[1] === 'reset-password' && request.method === 'POST') {
      const record = await store.get(clientId);
      if (!record) return jsonError('not_found', 'Client access not found', 404);

      const password = generatePassword();
      const salt = generateSalt();
      await store.update(clientId, {
        passwordHash: await hashPassword(password, salt),
        salt,
        failedAttempts: 0,
        lockedUntil: null,
      });
      return json({ password });
    }

    // POST /:id/revoke — block future sign-ins (record kept).
    if (segments.length === 2 && segments[1] === 'revoke' && request.method === 'POST') {
      const updated = await store.update(clientId, { revoked: true });
      if (!updated) return jsonError('not_found', 'Client access not found', 404);
      return json(store.toAccess(updated));
    }

    // POST /:id/language — set the preferred UI language.
    if (segments.length === 2 && segments[1] === 'language' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { language?: unknown } | null;
      const language = body?.language;
      if (language !== 'en' && language !== 'fr') {
        return jsonError('invalid_input', 'language must be "en" or "fr"', 400);
      }

      const updated = await store.update(clientId, { language });
      if (!updated) return jsonError('not_found', 'Client access not found', 404);
      return json(store.toAccess(updated));
    }

    // DELETE /:id — permanently remove the access.
    if (segments.length === 1 && request.method === 'DELETE') {
      const record = await store.get(clientId);
      if (!record) return jsonError('not_found', 'Client access not found', 404);
      await store.delete(clientId);
      return json({ success: true });
    }

    return jsonError('not_found', 'Client route not found', 404);
  },
};
