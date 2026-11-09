import { apiRequest } from './client';
import type { ReviewMergeResult, ReviewPullRequest } from '@cms/shared';

/**
 * Review workflow API endpoints (admin only).
 *
 * Client saves made in review mode open pull requests on cms/* branches;
 * these endpoints list them and approve (merge + publish) or reject
 * (close + reset) them.
 */

/** Lists every open review pull request across approval-mode accesses. */
export async function listReviewPullRequests(): Promise<ReviewPullRequest[]> {
  return apiRequest<ReviewPullRequest[]>('/api/review', {});
}

/** Approves a change: merges its pull request and triggers production deploys. */
export async function mergeReviewPullRequest(
  owner: string,
  repo: string,
  number: number,
): Promise<ReviewMergeResult> {
  return apiRequest<ReviewMergeResult>(
    `/api/review/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}/merge`,
    { method: 'POST' },
  );
}

/** Rejects a change: closes its pull request and resets the review branch. */
export async function closeReviewPullRequest(
  owner: string,
  repo: string,
  number: number,
): Promise<{ success: boolean }> {
  return apiRequest<{ success: boolean }>(
    `/api/review/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}/close`,
    { method: 'POST' },
  );
}
