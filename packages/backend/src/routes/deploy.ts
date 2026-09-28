/**
 * Deploy routes.
 *
 * Hosting-platform integration for publishing GitHub-hosted sites to
 * Cloudflare Pages and Vercel:
 *
 * Endpoints (all under /api/deploy):
 *   GET    /connections           — list the admin's platform connections (admin)
 *   POST   /connections/:platform — connect/replace a platform token (admin)
 *   DELETE /connections/:platform — disconnect a platform (admin)
 *   GET    /projects             — list platform projects (admin)
 *   GET    /links/:owner/:repo   — platform projects linked to one repository
 *   POST   /links/:owner/:repo/publish — trigger production deployments (admin)
 *   GET    /links/:owner/:repo/status  — latest deployment summaries (admin)
 *
 * Security model (matches the GitHub proxy):
 *  - Platform API tokens live only in KV, AES-GCM encrypted, keyed by the
 *    admin's GitHub login; never returned to the frontend.
 *  - Publishing requires an admin session. Client sessions can read links
 *    (so the UI can show deployment state) but cannot trigger deploys.
 *  - All requests carry the global CSRF + security-header middleware.
 */

import type {
  DeployConnection,
  DeployLink,
  DeployPlatform,
  DeployProject,
  PublishResult,
  RepoRef,
  SessionKind,
} from '@cms/shared';
import { json, jsonError, readSessionToken } from '../core/http';
import { SessionManager, resolveEncryptionKey } from '../services/auth';
import type { SessionRecord } from '../services/auth';
import { GitHubClient, mapGitHubError, isValidOwnerRepo } from '../services/github';
import {
  CloudflarePagesClient,
  ConnectionStore,
  VercelClient,
  mapDeployError,
  runWithConnection,
} from '../services/deploy';
import type { DeployErrorFallback } from '../services/deploy';
import { PlatformError } from '../services/deploy';
import type { ConnectionRecord } from '../services/deploy';
import type { RouteContext } from './index';

/** Deploy error fallback shared by every handler in this module. */
const DEPLOY_FALLBACK: DeployErrorFallback = {
  code: 'deploy_error',
  message: 'Hosting platform request failed',
  status: 502,
};

/** The platforms the CMS supports. */
const PLATFORMS: DeployPlatform[] = ['cloudflare', 'vercel'];

/** True when the string is a supported platform. */
function isPlatform(value: string): value is DeployPlatform {
  return value === 'cloudflare' || value === 'vercel';
}

/**
 * Resolves the session and the admin login that owns deploy connections.
 *
 * Deploy connections are keyed by the admin's GitHub login. Client sessions
 * inherit the visibility of their own session only — they can read links
 * (their locked repo) but cannot manage connections or publish.
 */
async function resolveSession(
  request: Request,
  ctx: RouteContext,
): Promise<{ session: SessionRecord; login: string; kind: SessionKind } | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const session = await new SessionManager(
    ctx.env.SESSION_KV,
    await resolveEncryptionKey(ctx.env),
  ).getSession(token);
  if (!session) return null;
  return { session, login: session.user.login, kind: session.kind ?? 'admin' };
}

/** Enforces the repository lock for client sessions on a repo-scoped route.
 * GitHub logins and repo names are case-insensitive — compare lowercased. */
function ensureRepoAccess(kind: SessionKind, repoLock: RepoRef | null, owner: string, repo: string): Response | null {
  if (
    kind === 'client' &&
    repoLock &&
    (repoLock.owner.toLowerCase() !== owner.toLowerCase() ||
      repoLock.repo.toLowerCase() !== repo.toLowerCase())
  ) {
    return jsonError('forbidden', 'This account can only access its assigned repository', 403);
  }
  return null;
}

/** Route handler for /api/deploy/*. */
export const deployRoutes = {
  async handle(path: string, request: Request, ctx: RouteContext): Promise<Response> {
    const resolved = await resolveSession(request, ctx);
    if (!resolved) {
      return jsonError('unauthorized', 'Not authenticated', 401);
    }
    const { session, login, kind } = resolved;
    const isAdmin = kind === 'admin';
    // Malformed %-escapes degrade to an empty/invalid reference instead of
    // throwing a URIError out of the handler.
    const segments = path
      .split('/')
      .filter(Boolean)
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return '';
        }
      });
    const store = new ConnectionStore(ctx.env.SESSION_KV, await resolveEncryptionKey(ctx.env));

    // GET /connections — the admin's stored connections (secrets stripped).
    if (segments[0] === 'connections' && segments.length === 1 && request.method === 'GET') {
      if (!isAdmin) return jsonError('admin_only', 'Only administrators can manage hosting platforms', 403);
      const records: Array<ConnectionRecord | null> = await Promise.all(
        PLATFORMS.map(async (platform) => store.get(login, platform)),
      );
      const connections: DeployConnection[] = records
        .filter((record): record is ConnectionRecord => record !== null)
        .map((record) => store.toConnection(record));
      return json(connections);
    }

    // POST /connections/:platform — connect (or replace) a platform token.
    if (segments[0] === 'connections' && segments.length === 2 && request.method === 'POST') {
      if (!isAdmin) return jsonError('admin_only', 'Only administrators can manage hosting platforms', 403);
      const platform = segments[1]!;
      if (!isPlatform(platform)) {
        return jsonError('invalid_platform', 'Platform must be "cloudflare" or "vercel"', 400);
      }
      const body = (await request.json().catch(() => null)) as {
        token?: unknown;
        accountId?: unknown;
      } | null;
      const token = typeof body?.token === 'string' ? body.token.trim() : '';
      if (!token) {
        return jsonError('invalid_input', 'A platform API token is required', 400);
      }
      const accountId =
        typeof body?.accountId === 'string' && body.accountId.trim()
          ? body.accountId.trim()
          : null;
      if (platform === 'cloudflare' && !accountId) {
        return jsonError('invalid_input', 'A Cloudflare account id is required', 400);
      }

      try {
        const client =
          platform === 'cloudflare'
            ? new CloudflarePagesClient(token, accountId!)
            : new VercelClient(token, accountId);
        // Verify before storing: a connect that fails must not persist a
        // dead credential. verify() throws PlatformError on auth failures.
        let accountName: string | null = null;
        if (client instanceof VercelClient) {
          const verified = await client.verify();
          accountName = verified.teamName ?? verified.accountName;
        } else {
          // per_page=1 probe — a full listing adds nothing to the check.
          await client.verify();
          accountName = accountId;
        }

        // Build the response record locally: re-reading KV right after the
        // put can serve a stale null (KV writes propagate asynchronously),
        // and the stored shape is exactly what was just verified.
        const record: Omit<ConnectionRecord, 'token'> & { token: string } = {
          platform,
          owner: login,
          token,
          accountId,
          accountName,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          tokenInvalid: false,
        };
        await store.put(record);
        return json(store.toConnection(record), 201);
      } catch (error) {
        return mapDeployError(error, DEPLOY_FALLBACK);
      }
    }

    // DELETE /connections/:platform — disconnect.
    if (segments[0] === 'connections' && segments.length === 2 && request.method === 'DELETE') {
      if (!isAdmin) return jsonError('admin_only', 'Only administrators can manage hosting platforms', 403);
      const platform = segments[1]!;
      if (!isPlatform(platform)) {
        return jsonError('invalid_platform', 'Platform must be "cloudflare" or "vercel"', 400);
      }
      const deleted = await store.delete(login, platform);
      if (!deleted) {
        return jsonError('not_found', 'No connection for this platform', 404);
      }
      return json({ success: true });
    }

    // ---- Platform projects ---------------------------------------------------

    // GET /projects — every connected platform's projects.
    if (segments[0] === 'projects' && segments.length === 1 && request.method === 'GET') {
      if (!isAdmin) return jsonError('admin_only', 'Only administrators can list hosting projects', 403);
      const projects: DeployProject[] = [];
      const failures: unknown[] = [];
      for (const platform of PLATFORMS) {
        const record = await store.get(login, platform);
        if (!record) continue;
        try {
          const list = await runWithConnection(ctx.env, store, record, ({ cloudflare, vercel }) =>
            (cloudflare ?? vercel!).listProjects(),
          );
          projects.push(...list);
          await store.touch(login, platform, {
            lastUsedAt: new Date().toISOString(),
            tokenInvalid: false,
          });
        } catch (error) {
          // A dead token on one platform must not hide the other's projects;
          // record it so the connection shows "invalid" in Settings.
          if (error instanceof PlatformError && (error.status === 401 || error.status === 403)) {
            await store.touch(login, platform, { tokenInvalid: true }).catch(() => {});
          }
          failures.push(error);
        }
      }
      if (projects.length === 0 && failures.length > 0) {
        return mapDeployError(failures[0], DEPLOY_FALLBACK);
      }
      return json(projects);
    }

    // ---- Repository links ----------------------------------------------------

    // Links need :owner/:repo segments.
    if (segments[0] !== 'links' || segments.length < 3) {
      return jsonError('not_found', 'Deploy route not found', 404);
    }
    const owner = segments[1]!;
    const repo = segments[2]!;
    // Owner/repo shape the upstream GitHub lookup for Git-linked projects;
    // reject anything that could reshape the request before any call.
    if (!isValidOwnerRepo(owner, repo)) {
      return jsonError('invalid_input', 'Invalid repository reference', 400);
    }
    const locked = ensureRepoAccess(kind, session.repoLock ?? null, owner, repo);
    if (locked) return locked;
    // Which admin's connections may serve a repo? The session's own login for
    // admins; client sessions carry the login of the admin who created their
    // access (session.connectionOwner) and resolve — read-only — through
    // that admin's connections. Legacy client sessions without the field
    // see no links (their synthetic label is NOT a connection owner — a
    // label equal to an admin's login must not read that admin's keys).
    const connectionOwner =
      session.connectionOwner ?? (kind === 'client' ? null : login);
    if (!connectionOwner) {
      // Legacy client session — resolvable answer, just always empty.
      if (segments.length === 3 && request.method === 'GET') return json([]);
      if (segments.length === 4 && segments[3] === 'status' && request.method === 'GET') {
        return json([]);
      }
      return jsonError('forbidden', 'This account cannot publish', 403);
    }

    /** Resolves links for the repo across all connected platforms. */
    const resolveLinks = async (): Promise<{ links: DeployLink[]; errors: unknown[] }> => {
      const links: DeployLink[] = [];
      const errors: unknown[] = [];
      for (const platform of PLATFORMS) {
        const record = await store.get(connectionOwner, platform);
        if (!record) continue;
        try {
          const projects = await runWithConnection(ctx.env, store, record, ({ cloudflare, vercel }) =>
            (cloudflare ?? vercel!).listProjects(),
          );
          for (const project of projects) {
            if (project.repo === `${owner}/${repo}`) {
              links.push({
                platform,
                projectName: project.name,
                mode: project.mode,
                url: project.url,
                latest: project.latest,
              });
            }
          }
        } catch (error) {
          if (error instanceof PlatformError && (error.status === 401 || error.status === 403)) {
            await store.touch(connectionOwner, platform, { tokenInvalid: true }).catch(() => {});
          }
          errors.push(error);
        }
      }
      return { links, errors };
    };

    // GET /links/:owner/:repo — projects publishing this repository.
    if (segments.length === 3 && request.method === 'GET') {
      const { links, errors } = await resolveLinks();
      // Link reads are read-only; partial failures degrade to the platforms
      // that answered rather than failing the whole call, but a total
      // failure surfaces the first error.
      if (links.length === 0 && errors.length > 0) {
        return mapDeployError(errors[0], DEPLOY_FALLBACK);
      }
      return json(links);
    }

    // POST /links/:owner/:repo/publish — trigger production deployments.
    if (segments.length === 4 && segments[3] === 'publish' && request.method === 'POST') {
      if (!isAdmin) {
        return jsonError('admin_only', 'Only administrators can publish', 403);
      }
      const { links, errors } = await resolveLinks();
      if (links.length === 0) {
        if (errors.length > 0) return mapDeployError(errors[0], DEPLOY_FALLBACK);
        return jsonError(
          'no_linked_project',
          'No hosting platform project is connected to this repository',
          404,
        );
      }

      // Vercel deploys from a Git ref: use the repository's real default
      // branch (Cloudflare derives it from the project itself, no ref
      // needed). The GitHub token in the session provides the branch.
      let defaultBranch: string | null = null;
      try {
        const github = new GitHubClient(session.githubToken);
        const repository = await github.getRepository(owner, repo);
        defaultBranch = repository.defaultBranch;
      } catch (error) {
        return mapGitHubError(error, {
          code: 'github_error',
          message: 'Failed to look up the repository branch for publishing',
          status: 502,
        });
      }

      const results: PublishResult[] = [];
      const failures: Array<{ platform: DeployPlatform; error: string }> = [];
      for (const link of links) {
        const record = await store.get(connectionOwner, link.platform);
        if (!record) continue;
        const message = `CMS: publish ${owner}/${repo}`;
        try {
          const deployment = await runWithConnection(
            ctx.env,
            store,
            record,
            ({ cloudflare, vercel }) =>
              cloudflare
                ? cloudflare.deploy(link.projectName, message)
                : vercel!.deployGit(link.projectName, owner, repo, defaultBranch!, message),
          );
          results.push({
            platform: link.platform,
            projectName: link.projectName,
            deploymentId: deployment.id,
            state: deployment.state,
          });
          await store.touch(connectionOwner, link.platform, {
            lastUsedAt: new Date().toISOString(),
            tokenInvalid: false,
          });
        } catch (error) {
          if (
            error instanceof PlatformError &&
            (error.status === 401 || error.status === 403)
          ) {
            await store.touch(connectionOwner, link.platform, { tokenInvalid: true }).catch(() => {});
          }
          failures.push({
            platform: link.platform,
            error: error instanceof Error ? error.message : 'publish failed',
          });
        }
      }

      if (results.length === 0 && failures.length > 0) {
        return jsonError(
          'publish_failed',
          `Publishing failed on ${failures[0]!.platform}: ${failures[0]!.error}`,
          502,
        );
      }
      return json({ deployments: results, failures });
    }

    // GET /links/:owner/:repo/status — per-platform latest deployment state.
    if (segments.length === 4 && segments[3] === 'status' && request.method === 'GET') {
      const { links, errors } = await resolveLinks();
      if (links.length === 0 && errors.length > 0) {
        return mapDeployError(errors[0], DEPLOY_FALLBACK);
      }
      const statuses: Array<{
        platform: DeployPlatform;
        projectName: string;
        latest: DeployLink['latest'];
      }> = links.map((link) => ({
        platform: link.platform,
        projectName: link.projectName,
        latest: link.latest,
      }));
      return json(statuses);
    }

    return jsonError('not_found', 'Deploy route not found', 404);
  },
};
