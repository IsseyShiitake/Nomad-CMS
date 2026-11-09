/**
 * Production-deploy service.
 *
 * Shared by the manual publish route (POST /api/deploy/links/:owner/:repo/publish)
 * and the review workflow (a merged approval pull request publishes the same
 * way an admin's direct save does). Resolves the platform projects linked to
 * the repository and triggers a production deployment on each.
 */

import type { DeployPlatform, PublishResult } from '@cms/shared';
import type { Env } from '../../env';
import { resolveEncryptionKey } from '../auth';
import { ConnectionStore } from './connections';
import { runWithConnection } from './refresh';
import { PlatformError } from './http';
import { GitHubClient } from '../github';

/** Everything a production deploy needs; callers supply their own session context. */
export interface ProductionDeployContext {
  env: Env;
  /** GitHub token used to resolve the repository's default branch (Vercel). */
  githubToken: string;
  /** The admin login whose deploy connections are used. */
  connectionOwner: string;
  owner: string;
  repo: string;
  /** Commit/deployment message describing the trigger. */
  message: string;
}

/** Outcome of a production-deploy attempt. */
export interface ProductionDeployOutcome {
  /** True when at least one platform project is linked to the repository. */
  linked: boolean;
  deployments: PublishResult[];
  failures: Array<{ platform: DeployPlatform; error: string }>;
}

/**
 * Lists the platform projects linked to owner/repo. A platform outage
 * degrades to the platforms that answered (matching the manual publish
 * route's semantics); only a total failure with zero links throws.
 */
async function resolveLinks(
  ctx: ProductionDeployContext,
  store: ConnectionStore,
): Promise<{
  links: Array<{ platform: DeployPlatform; projectName: string }>;
}> {
  const links: Array<{ platform: DeployPlatform; projectName: string }> = [];
  const errors: unknown[] = [];
  for (const platform of ['cloudflare', 'vercel'] as const) {
    const record = await store.get(ctx.connectionOwner, platform);
    if (!record) continue;
    try {
      const projects = await runWithConnection(ctx.env, store, record, ({ cloudflare, vercel }) =>
        (cloudflare ?? vercel!).listProjects(),
      );
      for (const project of projects) {
        if (project.repo === `${ctx.owner}/${ctx.repo}`) {
          links.push({ platform, projectName: project.name });
        }
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (links.length === 0 && errors.length > 0) {
    throw errors[0];
  }
  return { links };
}

/**
 * Triggers production deployments on every platform project linked to the
 * repository. Mirrors the semantics of the manual publish route: partial
 * failures are reported per platform; zero links is a no-op success.
 */
export async function triggerProductionDeploy(
  ctx: ProductionDeployContext,
): Promise<ProductionDeployOutcome> {
  const store = new ConnectionStore(ctx.env.SESSION_KV, await resolveEncryptionKey(ctx.env));
  const { links } = await resolveLinks(ctx, store);

  // Vercel deploys from a Git ref: use the repository's real default branch
  // (Cloudflare derives it from the project itself, no ref needed). Resolved
  // whenever any project is linked, matching the manual publish route's
  // request sequence.
  let defaultBranch: string | null = null;
  if (links.length > 0) {
    const github = new GitHubClient(ctx.githubToken);
    defaultBranch = (await github.getRepository(ctx.owner, ctx.repo)).defaultBranch;
  }

  const deployments: PublishResult[] = [];
  const failures: Array<{ platform: DeployPlatform; error: string }> = [];
  for (const link of links) {
    try {
      const record = await store.get(ctx.connectionOwner, link.platform);
      if (!record) continue;
      const deployment = await runWithConnection(
        ctx.env,
        store,
        record,
        ({ cloudflare, vercel }) =>
          cloudflare
            ? cloudflare.deploy(link.projectName, ctx.message)
            : vercel!.deployGit(link.projectName, ctx.owner, ctx.repo, defaultBranch!, ctx.message),
      );
      deployments.push({
        platform: link.platform,
        projectName: link.projectName,
        deploymentId: deployment.id,
        state: deployment.state,
      });
      await store.touch(ctx.connectionOwner, link.platform, {
        lastUsedAt: new Date().toISOString(),
        tokenInvalid: false,
      });
    } catch (error) {
      if (error instanceof PlatformError && (error.status === 401 || error.status === 403)) {
        await store.touch(ctx.connectionOwner, link.platform, { tokenInvalid: true }).catch(() => {});
      }
      failures.push({
        platform: link.platform,
        error: error instanceof Error ? error.message : 'publish failed',
      });
    }
  }

  return { linked: links.length > 0, deployments, failures };
}
