/**
 * Review workflow domain types.
 *
 * A client access with `requireApproval` saves to a per-client review branch
 * (`cms/<clientId>`) and keeps one open pull request to the production
 * branch. The admin reviews and merges (approve) or closes + resets the
 * branch (reject). Production sites only ever build from the default branch,
 * so nothing a client writes goes live before the merge.
 */

/** An open review pull request, as listed for the admin. */
export interface ReviewPullRequest {
  owner: string;
  repo: string;
  number: number;
  title: string;
  /** GitHub pull-request URL (diff view, merge button). */
  url: string;
  /** Head branch of the pull request (`cms/<clientId>`). */
  branch: string;
  /** Target (production) branch. */
  baseBranch: string;
  updatedAt: string | null;
  /** The client access the branch belongs to (parsed from the branch), when known. */
  clientId: string | null;
  /** The client access label, when the access still exists. */
  label: string | null;
}

/** Result of an approve (merge) action. */
export interface ReviewMergeResult {
  success: boolean;
  /** True when production deployments were triggered after the merge. */
  published: boolean;
  /** Per-platform deployment failures (already merged despite these). */
  failures: Array<{ platform: string; error: string }>;
  error: string | null;
}
