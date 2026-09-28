/**
 * Shared path utilities.
 *
 * Helpers for encoding repository paths consistently across the
 * frontend and backend. Both sides need to encode multi-segment
 * paths (e.g. "src/pages/index.html") for use in GitHub API URLs,
 * so the logic lives here to prevent drift.
 */

/**
 * Encodes a repository-relative path for use in a URL path segment.
 *
 * Each segment is independently percent-encoded, then joined with
 * "/". This matches the GitHub API's expectation that slashes
 * between path segments are literal while the segment contents are
 * encoded.
 *
 * @example
 *   encodePath("src/pages/index.html") // "src/pages/index.html"
 *   encodePath("my folder/file.html")   // "my%20folder/file.html"
 */
export function encodePath(path: string): string {
  return path
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

/**
 * Image file extensions the CMS permits uploading.
 *
 * SVG is intentionally excluded: an SVG can carry <script>, so allowing
 * uploads would open a stored-XSS path on the deployed static site. SVGs
 * already committed to a repo are still listed and served read-only.
 */
const IMAGE_EXTENSIONS: Record<string, true> = {
  png: true, jpg: true, jpeg: true, gif: true, webp: true, avif: true,
};

/** Maximum image upload size in bytes (10 MiB). Caps base64/JSON body growth. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Returns the lowercased extension (without dot) of a filename, or ''. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Extracts the bare filename, stripping any path separators.
 *
 * User-supplied filenames (from multipart uploads) are untrusted: they may
 * contain path components ("../foo.png") or Windows separators. Only the
 * final segment is used so the upload always lands under its target dir.
 */
export function basename(name: string): string {
  const parts = name.replace(/[\\/]+/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/**
 * Sanitizes a user-supplied image filename.
 *
 * Returns a safe basename whose extension is in the allowlist, or null if
 * the name is empty, a dotfile, or has a disallowed extension.
 */
export function sanitizeImageFileName(name: string): string | null {
  const base = basename(name);
  if (!base || base.startsWith('.')) return null;
  if (!IMAGE_EXTENSIONS[extensionOf(base)]) return null;
  return base;
}

/**
 * Validates a repository-relative page path for read/write.
 *
 * Returns the normalized path if it is safe, or null if it is empty,
 * absolute, contains traversal (".." / "."), hidden segments
 * (".github"), backslashes, or does not end in ".html"/".htm".
 *
 * This is the server-side guard against a leaked session token being used
 * to overwrite arbitrary files (e.g. ".github/workflows/ci.yml") in any
 * repo the token can write.
 */
export function safePagePath(path: string): string | null {
  if (!path) return null;
  if (path.startsWith('/') || path.startsWith('\\')) return null;
  const segments = path.replace(/\\/g, '/').split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
    if (segment.startsWith('.')) return null;
  }
  const ext = extensionOf(segments[segments.length - 1]);
  if (ext !== 'html' && ext !== 'htm') return null;
  return segments.join('/');
}

/**
 * Validates a repository-relative asset path for preview reads.
 *
 * Returns the normalized path if it is safe, or null if it is empty,
 * absolute, contains traversal (".." / "."), hidden segments
 * (".github"), or backslashes. Unlike `safePagePath` there is no
 * extension restriction: any non-hidden file (css, js, images,
 * fonts) is a legal preview asset.
 */
export function safeAssetPath(path: string): string | null {
  if (!path) return null;
  if (path.startsWith('/') || path.startsWith('\\')) return null;
  const segments = path.replace(/\\/g, '/').split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
    if (segment.startsWith('.')) return null;
  }
  return segments.join('/');
}