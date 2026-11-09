/**
 * Review workflow routes (admin only).
 *
 * The approval queue for client saves made in review mode: those saves land
 * on a `cms/<clientId>` branch with one open pull request to the production
 * branch. Nothing here is reachable by client sessions.
 *
 * Endpoints (all under /api/review):
 *   GET  /                                — open review pull requests
 *   POST /:owner/:repo/:number/merge      — approve: merge, then publish
 *   POST /:owner/:repo/:number/close      — reject: close PR, reset branch
 */

import type { ReviewMergeResult, ReviewPullRequest } from '@cms/shared';
import { json, jsonError, readSessionToken } from '../core/http';
import { ClientStore, SessionManager, resolveEncryptionKey } from '../services/auth';
import type { GitHubPullRequest } from '../services/github';
import { GitHubClient, GitHubError, mapGitHubError, isValidOwnerRepo } from '../services/github';
import { triggerProductionDeploy } from '../services/deploy';
import type { RouteContext } from './index';

/** Resolves the session and enforces the admin-only guard. */
async function requireAdmin(
  request: Request,
  ctx: RouteContext,
): Promise<{ githubToken: string; login: string } | Response> {
  const token = readSessionToken(request);
  if (!token) return jsonError('unauthorized', 'Not authenticated', 401);

  const sessions = new SessionManager(ctx.env.SESSION_KV, await resolveEncryptionKey(ctx.env));
  const session = await sessions.getSession(token);
  if (!session) return jsonError('unauthorized', 'Not authenticated', 401);
  if ((session.kind ?? 'admin') !== 'admin') {
    return jsonError('admin_only', 'Only administrators can review client changes', 403);
  }
  return { githubToken: session.githubToken, login: session.user.login };
}

/** Route handler for /api/review/*. */
export const reviewRoutes = {
  async handle(path: string, request: Request, ctx: RouteContext): Promise<Response> {
    const admin = await requireAdmin(request, ctx);
    if (admin instanceof Response) return admin;
    const { githubToken, login } = admin;
    const client = new GitHubClient(githubToken);
    const store = new ClientStore(ctx.env.SESSION_KV, await resolveEncryptionKey(ctx.env));

    const segments = path
      .split('/')
      .filter(Boolean)
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return '';
        }
      });

    // GET / — every open cms/* pull request across approval-mode accesses.
    if (segments.length === 0 && request.method === 'GET') {
      const records = (await store.list()).filter(
        (record) => record.requireApproval && !record.revoked,
      );
      // One listing per distinct repository, not per access.
      const repos = new Map<string, string>();
      for (const record of records) {
        repos.set(`${record.repo.owner}/${record.repo.repo}`, record.repo.owner);
      }
      const pulls: ReviewPullRequest[] = [];
      for (const [fullName, owner] of repos) {
        const repo = fullName.split('/')[1]!;
        let open: GitHubPullRequest[];
        try {
          open = await client.listOpenPullRequests(owner, repo);
        } catch {
          continue; // one unreachable repo must not hide the rest of the queue
        }
        for (const pr of open) {
          if (!pr.head.ref.startsWith('cms/')) continue;
          const clientId = pr.head.ref.slice('cms/'.length);
          const record = records.find((entry) => entry.clientId === clientId) ?? null;
          pulls.push({
            owner,
            repo,
            number: pr.number,
            title: pr.title,
            url: pr.html_url,
            branch: pr.head.ref,
            baseBranch: pr.base.ref,
            updatedAt: pr.updated_at,
            clientId: record ? clientId : null,
            label: record?.label ?? null,
          });
        }
      }
      return json(pulls);
    }

    // POST /:owner/:repo/:number/merge — approve and publish.
    if (
      segments.length === 4 &&
      segments[3] === 'merge' &&
      request.method === 'POST' &&
      Number.isInteger(Number(segments[2]))
    ) {
      const [owner, repo, numberSegment] = segments;
      const number = Number(numberSegment);
      if (!isValidOwnerRepo(owner, repo)) {
        return jsonError('invalid_input', 'Invalid repository reference', 400);
      }

      try {
        // Routine staleness first: merge the production branch into the review
        // branch so the merge itself succeeds. A no-op update and a real
        // conflict both answer 422 here — the merge below is the verdict.
        await client.updatePullRequestBranch(owner, repo, number).catch(() => {});
        await client.mergePullRequest(owner, repo, number);
      } catch (error) {
        if (error instanceof GitHubError && error.status === 409) {
          // Already merged (double-click on the approve button): the outcome
          // the admin wanted is in place — fall through to publishing.
        } else if (error instanceof GitHubError && (error.status === 405 || error.status === 422)) {
          return jsonError(
            'review_conflict',
            'This change conflicts with the current site content. Resolve it on GitHub, then merge.',
            409,
          );
        } else {
          return mapGitHubError(error, {
            code: 'github_error',
            message: 'Failed to merge the change',
            status: 502,
          });
        }
      }

      // Merged. Publish the same way the admin editor's auto-publish does;
      // git-integrated platforms deploy from the default branch on their own.
      let published = false;
      const failures: Array<{ platform: string; error: string }> = [];
      try {
        const outcome = await triggerProductionDeploy({
          env: ctx.env,
          githubToken,
          connectionOwner: login,
          owner,
          repo,
          message: `CMS: approved change for ${owner}/${repo}`,
        });
        published = outcome.deployments.length > 0;
        failures.push(...outcome.failures);
      } catch {
        // The merge already succeeded; a platform outage must not read as a
        // failed approval. The manual publish button remains available.
      }

      const payload: ReviewMergeResult = {
        success: true,
        published,
        failures,
        error: null,
      };
      return json(payload);
    }

    // POST /:owner/:repo/:number/close — reject and reset the branch.
    if (
      segments.length === 4 &&
      segments[3] === 'close' &&
      request.method === 'POST' &&
      Number.isInteger(Number(segments[2]))
    ) {
      const [owner, repo, numberSegment] = segments;
      const number = Number(numberSegment);
      if (!isValidOwnerRepo(owner, repo)) {
        return jsonError('invalid_input', 'Invalid repository reference', 400);
      }

      try {
        // Learn the PR's head branch first: only cms/* review branches are
        // ever deleted here, and the reset needs the exact name.
        const pr = await client.getPullRequest(owner, repo, number);
        await client.closePullRequest(owner, repo, number);
        // Reset the branch so the client's NEXT save starts fresh from the
        // production HEAD — rejected commits never resurface. A missing
        // branch is fine (nothing to reset).
        if (pr.head.ref.startsWith('cms/')) {
          await client.deleteBranch(owner, repo, pr.head.ref).catch((error: unknown) => {
            if (!(error instanceof GitHubError && error.status === 404)) throw error;
          });
        }
      } catch (error) {
        if (error instanceof GitHubError && error.status === 404) {
          return jsonError('not_found', 'Pull request not found', 404);
        }
        return mapGitHubError(error, {
          code: 'github_error',
          message: 'Failed to close the change',
          status: 502,
        });
      }
      return json({ success: true });
    }

    return jsonError('not_found', 'Review route not found', 404);
  },
};
