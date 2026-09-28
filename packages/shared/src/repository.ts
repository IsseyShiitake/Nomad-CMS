/**
 * Repository domain types.
 *
 * Represents a GitHub repository that the CMS can manage.
 * The backend (Cloudflare Worker) is the only component that
 * talks to the GitHub API; the frontend only ever sees these
 * DTOs.
 */

/** A GitHub repository the user has authorized the CMS to access. */
export interface Repository {
  /** GitHub repository ID. */
  id: number;

  /** Repository name, e.g. "my-static-site". */
  name: string;

  /** Owner login, e.g. "octocat". */
  owner: string;

  /** Full name in the form "owner/name". */
  fullName: string;

  /** Default branch, e.g. "main". */
  defaultBranch: string;

  /** Short description, if any. */
  description: string | null;

  /** Whether the repository is private. */
  isPrivate: boolean;

  /** Optional repository homepage (GitHub API `homepage` field) — the
   * site's own URL when the owner configured one; used as the preview
   * source before falling back to the conventional Pages URL. */
  homepage?: string | null;

  /** URL to the repository's page on GitHub. */
  htmlUrl: string;

  /** When the repository was last pushed to. */
  updatedAt: string;

  /** Whether the repository contains at least one HTML file.
   *
   * `false` = checked and none found (the listing hides it — the CMS
   * cannot edit it); `null`/omitted = unknown (not checked, check
   * failed, or a virtual direct-storage repo), which listings still
   * show. */
  hasHtml?: boolean | null;
}

/** A file within a repository. */
export interface RepositoryFile {
  /** Path relative to the repository root, e.g. "index.html". */
  path: string;

  /** File name, e.g. "index.html". */
  name: string;

  /** MIME type or language hint when known. */
  type: 'file' | 'dir';

  /** Size in bytes (files only). */
  size: number;

  /** SHA of the file blob, used for updates. */
  sha: string | null;
}