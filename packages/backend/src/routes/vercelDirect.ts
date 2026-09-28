/**
 * Vercel-direct route fallback.
 *
 * Direct-upload Vercel projects (no Git repository) are exposed through the
 * repository routes under the virtual owner "vercel": the frontend treats
 * `vercel/<project>` like any repository, and these handlers answer from the
 * project's latest production deployment instead of the GitHub API. Only
 * admin sessions reach them — the connection (and its token) belongs to the
 * administrator.
 */

import type { Repository } from '@cms/shared';
import { jsonError } from '../core/http';
import { resolveEncryptionKey } from '../services/auth';
import { ConnectionStore, runWithConnection } from '../services/deploy';
import type { ConnectionRecord } from '../services/deploy';
import { VercelDirectStore, projectToRepository } from '../services/deploy/vercelDirect';
import type { RouteContext } from './index';

/** Virtual owner namespace for Vercel-direct projects. */
export const VERCEL_OWNER = 'vercel';

/** Resolved direct-storage context for one virtual repository. */
export interface DirectContext {
  store: VercelDirectStore;
  repository: Repository;
}

/**
 * Resolves the direct-storage context for one virtual repository.
 *
 * Returns null when the route is not applicable (a GitHub owner — the
 * caller falls through), a Response on failure, or the context on success.
 * `login` is the calling admin's GitHub login; connections are keyed by it.
 */
export async function resolveDirect(
  ctx: RouteContext,
  login: string,
  owner: string,
  repoName: string,
  kind: string,
): Promise<DirectContext | Response | null> {
  if (owner !== VERCEL_OWNER) return null;
  if (kind !== 'admin') {
    // Client sessions never own a platform connection; the virtual namespace
    // is invisible to them (it does not appear in their repository list).
    return jsonError('not_found', 'Repository not found', 404);
  }
  const connections = new ConnectionStore(ctx.env.SESSION_KV, await resolveEncryptionKey(ctx.env));
  const record: ConnectionRecord | null = await connections.get(login, 'vercel');
  if (!record) {
    return jsonError('not_connected', 'Vercel is not connected — add it in Settings', 404);
  }
  const { client, project } = await runWithConnection(ctx.env, connections, record, ({ vercel }) =>
    vercel!.getProject(repoName).then((found) => ({ client: vercel!, project: found })),
  );
  if (!project || project.mode !== 'direct') {
    return jsonError('not_found', 'Vercel project not found', 404);
  }
  return {
    store: new VercelDirectStore(client, project, project.latest?.id ?? null),
    repository: projectToRepository(project),
  };
}

/** Lists the calling admin's direct Vercel projects as repositories. */
export async function listDirectRepositories(
  ctx: RouteContext,
  login: string,
): Promise<Repository[]> {
  const connections = new ConnectionStore(ctx.env.SESSION_KV, await resolveEncryptionKey(ctx.env));
  const record = await connections.get(login, 'vercel');
  if (!record) return [];
  const projects = await runWithConnection(ctx.env, connections, record, ({ vercel }) =>
    vercel!.listProjects(),
  );
  return projects
    .filter((project) => project.mode === 'direct')
    .map(projectToRepository);
}

