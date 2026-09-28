/**
 * Page domain types.
 *
 * A "page" is a single HTML document within a repository that
 * the CMS can edit. The HTML parser module (frontend) will
 * convert raw HTML into an editable document model; these types
 * describe the persisted/transported shape.
 */

/** A page within a repository. */
export interface Page {
  /** Repository-relative path, e.g. "index.html". */
  path: string;

  /** Raw HTML content of the page. */
  content: string;

  /** SHA of the file, used for optimistic concurrency on save. */
  sha: string | null;

  /** Last modified timestamp from the repository. */
  updatedAt: string | null;
}

/** Summary of a page, used for list views.
 *
 * Just the path: the git tree (the cheapest listing source) carries only
 * path/sha/size, and every richer field would need one content request
 * per page — the burst that caused 429 rate-limits. Lists render the
 * path. */
export interface PageSummary {
  /** Repository-relative path, e.g. "index.html". */
  path: string;
}

/** Result of saving a page back to the repository. */
export interface SavePageResult {
  /** Whether the save succeeded. */
  success: boolean;

  /** New SHA of the saved file, if successful. */
  sha: string | null;

  /** Human-readable error message, if the save failed. */
  error: string | null;
}