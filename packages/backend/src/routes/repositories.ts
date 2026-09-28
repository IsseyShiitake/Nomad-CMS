/**
 * Repository routes.
 *
 * Proxies GitHub repository operations. The Worker holds the
 * GitHub token and calls the GitHub API on behalf of the user;
 * the frontend never sees GitHub credentials.
 *
 * Endpoints:
 *   GET  /                          — list repositories
 *   GET  /:owner/:repo              — repository metadata
 *   GET  /:owner/:repo/contents/:path — list contents at a path
 *   GET  /:owner/:repo/pages        — discover HTML files
 *   GET  /:owner/:repo/pages/:path  — read an HTML file
 *   PUT  /:owner/:repo/pages/:path  — save (commit) an HTML file
 *   GET  /:owner/:repo/images       — list image assets
 *   POST /:owner/:repo/images       — upload an image asset
 */

import type {
  ImageAsset,
  Page,
  PageSummary,
  RepoRef,
  Repository,
  RepositoryFile,
  SavePageResult,
  SessionKind,
} from '@cms/shared';
import {
  MAX_IMAGE_BYTES,
  safePagePath,
  safeAssetPath,
  sanitizeImageFileName,
} from '@cms/shared';
import { readSessionToken, json, jsonError, SECURITY_HEADERS } from '../core/http';
import { SessionManager, resolveEncryptionKey } from '../services/auth';
import type { SessionRecord } from '../services/auth';
import { GitHubClient, mapGitHubError, isValidOwnerRepo } from '../services/github';
import type { ErrorFallback } from '../services/github';
import { TreeTruncatedError } from '../services/github';
import type { RouteContext } from './index';
import { resolveDirect, listDirectRepositories } from './vercelDirect';
import type { DirectContext } from './vercelDirect';
import { mapDeployError } from '../services/deploy';

/** Splits a route path into encoded segments. */
function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** Decodes a URL-encoded path segment; malformed escapes degrade to the
 * original text (GitHub then answers a clean 404) instead of throwing. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Resolves the session behind a request: GitHub client, kind, repo lock, login. */
async function resolveSession(
  request: Request,
  ctx: RouteContext,
): Promise<{ client: GitHubClient; kind: SessionKind; repoLock: RepoRef | null; login: string } | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const sessions = new SessionManager(ctx.env.SESSION_KV, await resolveEncryptionKey(ctx.env));
  const session: SessionRecord | null = await sessions.getSession(token);
  if (!session) return null;
  return {
    client: new GitHubClient(session.githubToken),
    kind: session.kind ?? 'admin',
    repoLock: session.repoLock ?? null,
    login: session.user.login,
  };
}

/**
 * Enforces the client session's repository lock. Returns a 403 response
 * when a locked session requests any repository other than its own,
 * otherwise null. GitHub logins and repo names are case-insensitive, so
 * both sides compare lowercased.
 */
function ensureRepo(repoLock: RepoRef | null, owner: string, repo: string): Response | null {
  if (
    repoLock &&
    (repoLock.owner.toLowerCase() !== owner.toLowerCase() ||
      repoLock.repo.toLowerCase() !== repo.toLowerCase())
  ) {
    return jsonError('forbidden', 'This account can only access its assigned repository', 403);
  }
  return null;
}

/** Builds the commit message for a page save. */
function pageCommitMessage(pagePath: string): string {
  return `CMS: Updated ${pagePath}`;
}

/** Builds the commit message for an image upload. */
function imageCommitMessage(imagePath: string): string {
  return `CMS: Uploaded ${imagePath}`;
}

/** Generic extension → MIME table for repository assets (preview proxy + image listings). */
const ASSET_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  txt: 'text/plain',
  xml: 'application/xml',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
};

/** Resolves the MIME type for a repository asset path via the generic table. */
function imageMimeType(imagePath: string): string {
  const extension = imagePath.split('.').pop()?.toLowerCase() ?? '';
  return ASSET_MIME[extension] ?? 'application/octet-stream';
}

/** Concurrency of the per-repository hasHtml checks in the listing. */
const HTML_CHECK_CONCURRENCY = 6;
/** Cap on hasHtml checks per listing — beyond it the flag stays unknown
 * (repos remain listed) so a very large account cannot turn one page
 * load into an unbounded request burst. */
const HTML_CHECK_LIMIT = 100;

/** Annotates the listing's repositories with `hasHtml` (see Repository).
 *
 * One recursive-tree request per GitHub repository (fixed HEAD ref) run
 * through a small concurrency pool. Virtual vercel/<project> repositories
 * are left unknown — their files live behind the direct store, not GitHub.
 * Any per-repo failure leaves that flag unknown too: only a checked
 * `false` (no HTML anywhere, or an empty repository) marks a repo as
 * HTML-less, so failures never silently hide a repository. */
async function annotateHasHtml(client: GitHubClient, repositories: Repository[]): Promise<void> {
  const targets = repositories
    .filter((repo) => repo.owner !== 'vercel')
    .slice(0, HTML_CHECK_LIMIT);
  let cursor = 0;
  async function checkNext(): Promise<void> {
    while (cursor < targets.length) {
      const repo = targets[cursor]!;
      cursor += 1;
      try {
        repo.hasHtml = await client.hasHtmlFiles(repo.owner, repo.name);
      } catch {
        repo.hasHtml = null;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(HTML_CHECK_CONCURRENCY, targets.length) }, () => checkNext()),
  );
}

/** Route handler for /api/repositories/*. */
export const repositoryRoutes = {
  async handle(path: string, request: Request, ctx: RouteContext): Promise<Response> {
    const resolved = await resolveSession(request, ctx);
    if (!resolved) {
      return jsonError('unauthorized', 'Not authenticated', 401);
    }
    const { client, kind, repoLock, login } = resolved;

    // Maps a GitHub failure for THIS session's kind: when a client session's
    // backing GitHub token dies, the client keeps its own CMS login and gets
    // a recoverable 403 instead of a session purge + silent bounce
    // (see mapGitHubError).
    const fail = (error: unknown, fallback: ErrorFallback): Response =>
      mapGitHubError(error, fallback, kind);

    // Virtual "vercel/<project>" repositories are served from the admin's
    // Vercel direct storage instead of GitHub. resolveDirect returns null
    // for GitHub owners (fall through) and a Response on direct failures.
    const direct = async (owner: string, repoName: string): Promise<DirectContext | Response | null> =>
      resolveDirect(ctx, login, owner, repoName, kind);

    // GET / — list repositories.
    if (path === '/' || path === '') {
      if (request.method !== 'GET') {
        return jsonError('method_not_allowed', 'Repository listing supports GET only', 405);
      }
      try {
        // Locked client sessions see exactly their assigned repository.
        let repositories: Repository[];
        if (repoLock) {
          repositories = [await client.getRepository(repoLock.owner, repoLock.repo)];
        } else {
          repositories = await client.listRepositories();
          // Admin sessions also see their Vercel-direct projects under the
          // virtual "vercel" owner, so those sites are editable end to end.
          try {
            repositories.push(...(await listDirectRepositories(ctx, login)));
          } catch {
            // Direct projects are additive; a Vercel outage must not hide
            // the GitHub repositories.
          }
        }
        await annotateHasHtml(client, repositories);
        return json(repositories);
      } catch (error) {
        return fail(error, { code: 'github_error', message: 'Failed to list repositories', status: 502 });
      }
    }

    const segments = splitPath(path);

    // Owner/repo charset guard: decoded segments are interpolated into
    // upstream GitHub API URLs; anything outside [A-Za-z0-9_.-] could
    // reshape the upstream request. The virtual "vercel" owner names a
    // Vercel project (arbitrary charset) and is resolved by the direct
    // store, so it is exempt.
    if (segments.length >= 2) {
      const [ownerSeg, repoSeg] = segments;
      const ownerName = decodeSegment(ownerSeg!);
      const repoName = decodeSegment(repoSeg!);
      if (ownerName !== 'vercel' && !isValidOwnerRepo(ownerName, repoName)) {
        return jsonError('invalid_input', 'Invalid repository reference', 400);
      }
    }

    // GET /:owner/:repo — repository metadata.
    if (segments.length === 2 && request.method === 'GET') {
      const [owner, repo] = segments;
      const locked = ensureRepo(repoLock, decodeSegment(owner), decodeSegment(repo));
      if (locked) return locked;
      // Virtual Vercel-direct repository: metadata comes from the project.
      try {
        const resolved = await direct(decodeSegment(owner), decodeSegment(repo));
        if (resolved instanceof Response) return resolved;
        if (resolved) return json(resolved.repository);
      } catch (error) {
        return mapDeployError(error, {
          code: 'deploy_error',
          message: 'Hosting platform request failed',
          status: 502,
        });
      }
      try {
        const repository = await client.getRepository(decodeSegment(owner), decodeSegment(repo));
        return json(repository);
      } catch (error) {
        return fail(error, { code: 'github_error', message: 'Failed to load repository', status: 502 });
      }
    }

    // GET /:owner/:repo/contents[/:path] — list contents at a path (root when omitted).
    if (segments.length >= 3 && segments[2] === 'contents') {
      if (request.method !== 'GET') {
        return jsonError('method_not_allowed', 'Contents listing supports GET only', 405);
      }
      const [owner, repo] = segments;
      const locked = ensureRepo(repoLock, decodeSegment(owner), decodeSegment(repo));
      if (locked) return locked;
      const contentPath = segments.slice(3).map(decodeSegment).join('/');
      // Virtual Vercel-direct repository: contents come from the deployment.
      try {
        const resolved = await direct(decodeSegment(owner), decodeSegment(repo));
        if (resolved instanceof Response) return resolved;
        if (resolved) {
          const files = await resolved.store.listContents(contentPath);
          return json(files);
        }
      } catch (error) {
        return mapDeployError(error, {
          code: 'deploy_error',
          message: 'Hosting platform request failed',
          status: 502,
        });
      }
      try {
        const files: RepositoryFile[] = await client.listContents(
          decodeSegment(owner),
          decodeSegment(repo),
          contentPath,
        );
        return json(files);
      } catch (error) {
        return fail(error, { code: 'github_error', message: 'Failed to list contents', status: 502 });
      }
    }

    // GET /:owner/:repo/raw/:path — proxy a repository file for the editor preview.
    if (segments.length >= 4 && segments[2] === 'raw' && request.method === 'GET') {
      const [owner, repo, , ...pathSegments] = segments;
      const locked = ensureRepo(repoLock, decodeSegment(owner), decodeSegment(repo));
      if (locked) return locked;
      const assetPath = safeAssetPath(pathSegments.map(decodeSegment).join('/'));
      if (!assetPath) {
        return jsonError('invalid_path', 'Asset not found', 404);
      }
      // Virtual Vercel-direct repository: asset bytes come from the deployment.
      try {
        const resolved = await direct(decodeSegment(owner), decodeSegment(repo));
        if (resolved instanceof Response) return resolved;
        if (resolved) {
          const bytes = await resolved.store.readRawFile(assetPath);
          if (!bytes) return jsonError('not_found', 'Asset not found', 404);
          const extension = assetPath.split('.').pop()?.toLowerCase() ?? '';
          return new Response(bytes, {
            headers: {
              ...SECURITY_HEADERS,
              'Content-Type': ASSET_MIME[extension] ?? 'application/octet-stream',
              'Cache-Control': 'private, max-age=300',
            },
          });
        }
      } catch (error) {
        return mapDeployError(error, {
          code: 'deploy_error',
          message: 'Hosting platform request failed',
          status: 502,
        });
      }
      try {
        const bytes = await client.readRawFile(decodeSegment(owner), decodeSegment(repo), assetPath);
        const extension = assetPath.split('.').pop()?.toLowerCase() ?? '';
        return new Response(bytes, {
          headers: {
            ...SECURITY_HEADERS,
            'Content-Type': ASSET_MIME[extension] ?? 'application/octet-stream',
            'Cache-Control': 'private, max-age=300',
          },
        });
      } catch (error) {
        return fail(error, { code: 'github_error', message: 'Failed to load the asset', status: 502 });
      }
    }

    // GET /:owner/:repo/pages — discover HTML files in the repository.
    if (segments.length === 3 && segments[2] === 'pages' && request.method === 'GET') {
      const [owner, repo] = segments;
      const locked = ensureRepo(repoLock, decodeSegment(owner), decodeSegment(repo));
      if (locked) return locked;
      // Virtual Vercel-direct repository: pages come from the deployment.
      try {
        const resolved = await direct(decodeSegment(owner), decodeSegment(repo));
        if (resolved instanceof Response) return resolved;
        if (resolved) {
          const pages = await resolved.store.listPages();
          return json(pages);
        }
      } catch (error) {
        return mapDeployError(error, {
          code: 'deploy_error',
          message: 'Hosting platform request failed',
          status: 502,
        });
      }
      try {
        // The fixed ref "HEAD" resolves to the repository's default branch,
        // so the tree can be listed without a prior metadata request.
        const tree = await client.listTree(decodeSegment(owner), decodeSegment(repo), 'HEAD');

        // Filter the git tree for HTML files. The tree payload already
        // carries each blob's size and sha, so page summaries need no
        // additional GitHub requests; anything richer (title, editable
        // count) would mean one request per page (the request burst that
        // caused 429s).
        const pages: PageSummary[] = tree
          .filter((item) => item.type === 'blob' && /\.html?$/i.test(item.path))
          .map((item) => ({ path: item.path }));

        return json(pages);
      } catch (error) {
        return fail(error, { code: 'github_error', message: 'Failed to discover HTML files', status: 502 });
      }
    }

    // GET /:owner/:repo/pages/:path — read a single HTML file.
    if (segments.length >= 4 && segments[2] === 'pages' && request.method === 'GET') {
      const [owner, repo, , ...pathSegments] = segments;
      const locked = ensureRepo(repoLock, decodeSegment(owner), decodeSegment(repo));
      if (locked) return locked;
      const pagePath = pathSegments.map(decodeSegment).join('/');
      const safePath = safePagePath(pagePath);
      if (!safePath) {
        return jsonError('invalid_path', 'Page not found', 404);
      }
      // Virtual Vercel-direct repository: the page is read from the latest
      // deployment. Direct deployments are immutable, so concurrency is
      // last-write-wins rather than sha-checked.
      try {
        const resolved = await direct(decodeSegment(owner), decodeSegment(repo));
        if (resolved instanceof Response) return resolved;
        if (resolved) {
          const file = await resolved.store.readFile(safePath);
          if (!file) return jsonError('not_found', 'Page not found', 404);
          const page: Page = {
            path: file.path,
            content: file.content,
            sha: null,
            updatedAt: null,
          };
          return json(page);
        }
      } catch (error) {
        return mapDeployError(error, {
          code: 'deploy_error',
          message: 'Hosting platform request failed',
          status: 502,
        });
      }
      try {
        const file = await client.readFile(
          decodeSegment(owner),
          decodeSegment(repo),
          safePath,
        );
        const page: Page = {
          path: file.path,
          content: file.content,
          sha: file.sha,
          updatedAt: null,
        };
        return json(page);
      } catch (error) {
        return fail(error, { code: 'github_error', message: 'Failed to load the page', status: 502 });
      }
    }

    // PUT /:owner/:repo/pages/:path — save (commit) an HTML file.
    if (segments.length >= 4 && segments[2] === 'pages' && request.method === 'PUT') {
      const [owner, repo, , ...pathSegments] = segments;
      const locked = ensureRepo(repoLock, decodeSegment(owner), decodeSegment(repo));
      if (locked) return locked;
      const pagePath = pathSegments.map(decodeSegment).join('/');
      const safePath = safePagePath(pagePath);
      if (!safePath) {
        return jsonError(
          'invalid_path',
          'Page path must be a .html file with no traversal or hidden segments',
          400,
        );
      }

      // Mirror the image route's pre-read gate: reject a declared body far
      // larger than any page could need before buffering it into memory.
      // The small envelope slack matches the image route so a page at the
      // exact limit is judged by the authoritative byte gate below, not by
      // its JSON wrapper.
      const declaredLength = Number.parseInt(request.headers.get('Content-Length') ?? '', 10);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES + 1024 * 1024) {
        return jsonError('invalid_content', 'Page content is too large', 413);
      }

      const body = (await request.json().catch(() => null)) as {
        content?: unknown;
        sha?: unknown;
      } | null;
      const content = typeof body?.content === 'string' ? body.content : null;
      const sha = typeof body?.sha === 'string' ? body.sha : null;

      if (content == null) {
        return jsonError('invalid_content', 'Page content is required', 400);
      }
      // Byte-accurate gate (string length undercounts multi-byte characters).
      if (new TextEncoder().encode(content).byteLength > MAX_IMAGE_BYTES) {
        return jsonError('invalid_content', 'Page content is too large', 413);
      }

      // Virtual Vercel-direct repository: saving uploads the changed file
      // and re-deploys with a full manifest (a new immutable deployment).
      try {
        const resolved = await direct(decodeSegment(owner), decodeSegment(repo));
        if (resolved instanceof Response) return resolved;
        if (resolved) {
          const { deploymentId } = await resolved.store.saveFile(
            safePath,
            content,
            pageCommitMessage(safePath),
          );
          const payload: SavePageResult = {
            success: true,
            sha: deploymentId,
            error: null,
          };
          return json(payload);
        }
      } catch (error) {
        return mapDeployError(error, {
          code: 'vercel_error',
          message: 'Failed to save the page to Vercel',
          status: 502,
        });
      }
      try {
        const result = await client.writeFile(
          decodeSegment(owner),
          decodeSegment(repo),
          safePath,
          content,
          sha,
          pageCommitMessage(safePath),
        );

        const payload: SavePageResult = {
          success: true,
          sha: result.sha,
          error: null,
        };
        return json(payload);
      } catch (error) {
        return fail(error, { code: 'github_error', message: 'Failed to save the page', status: 502 });
      }
    }

    // GET /:owner/:repo/images — list image assets in the repository.
    if (segments.length === 3 && segments[2] === 'images' && request.method === 'GET') {
      const [owner, repo] = segments;
      const locked = ensureRepo(repoLock, decodeSegment(owner), decodeSegment(repo));
      if (locked) return locked;
      // Virtual Vercel-direct repository: images come from the deployment.
      try {
        const resolved = await direct(decodeSegment(owner), decodeSegment(repo));
        if (resolved instanceof Response) return resolved;
        if (resolved) {
          const assets = await resolved.store.listImages();
          const images: ImageAsset[] = assets.map((asset) => ({
            path: asset.path,
            name: asset.path.split('/').pop() ?? asset.path,
            size: asset.size,
            mimeType: imageMimeType(asset.path),
            sha: null,
            updatedAt: null,
          }));
          return json(images);
        }
      } catch (error) {
        return mapDeployError(error, {
          code: 'deploy_error',
          message: 'Hosting platform request failed',
          status: 502,
        });
      }
      try {
        // "HEAD" resolves to the default branch — no metadata request needed.
        const tree = await client.listTree(decodeSegment(owner), decodeSegment(repo), 'HEAD');

        // Filter the git tree for common image file extensions. The tree
        // payload already includes each blob's real size and sha, so use
        // them instead of the previous hardcoded placeholders.
        const images: ImageAsset[] = tree
          .filter((item) => item.type === 'blob' && /\.(png|jpe?g|gif|svg|webp|avif|ico)$/i.test(item.path))
          .map((item) => ({
            path: item.path,
            name: item.path.split('/').pop() ?? item.path,
            size: item.size ?? 0,
            mimeType: imageMimeType(item.path),
            sha: item.sha,
            updatedAt: null,
          }));

        return json(images);
      } catch (error) {
        return fail(error, { code: 'github_error', message: 'Failed to list images', status: 502 });
      }
    }

    // POST /:owner/:repo/images — upload an image asset.
    if (segments.length === 3 && segments[2] === 'images' && request.method === 'POST') {
      const [owner, repo] = segments;
      const locked = ensureRepo(repoLock, decodeSegment(owner), decodeSegment(repo));
      if (locked) return locked;
      // Reject oversized uploads before buffering the multipart body into
      // isolate memory. The declared Content-Length may be absent (chunked)
      // — the post-read byteLength check below remains authoritative.
      const declaredLength = Number.parseInt(
        request.headers.get('Content-Length') ?? '',
        10,
      );
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAX_IMAGE_BYTES + 1024 * 1024
      ) {
        return jsonError('file_too_large', 'Image must be 10 MiB or smaller', 413);
      }
      try {
        const formData = await request.formData();
        const entry = formData.get('file');
        // The Worker type environment does not expose a global File
        // type, so we use a structural guard: a file is a non-string
        // entry that exposes arrayBuffer().
        if (typeof entry === 'string' || !entry) {
          return jsonError('invalid_file', 'A file is required', 400);
        }
        const file = entry as unknown as {
          arrayBuffer: () => Promise<ArrayBuffer>;
          type: string;
          name: string;
          size?: number;
        };
        if (typeof file.arrayBuffer !== 'function') {
          return jsonError('invalid_file', 'A file is required', 400);
        }
        // Reject oversized uploads on the declared size BEFORE buffering the
        // body into isolate memory. The post-read byteLength check below
        // remains authoritative (a declared size can lie).
        if (typeof file.size === 'number' && file.size > MAX_IMAGE_BYTES) {
          return jsonError('file_too_large', 'Image must be 10 MiB or smaller', 413);
        }

        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
          return jsonError('file_too_large', 'Image must be 10 MiB or smaller', 413);
        }
        const safeName = sanitizeImageFileName(file.name);
        if (!safeName) {
          return jsonError(
            'invalid_file',
            'Image must be a png, jpg, jpeg, gif, webp, or avif file',
            400,
          );
        }
        const declaredType = file.type || '';
        if (declaredType && !declaredType.startsWith('image/')) {
          return jsonError('invalid_file', 'File must be an image', 400);
        }
        const mimeType = declaredType || 'application/octet-stream';
        const imagePath = `images/${safeName}`;

        // Virtual Vercel-direct repository: upload the bytes and re-deploy
        // with a full manifest (the image path joins the site's files).
        try {
          const resolved = await direct(decodeSegment(owner), decodeSegment(repo));
          if (resolved instanceof Response) return resolved;
          if (resolved) {
            const { deploymentId } = await resolved.store.uploadImage(
              imagePath,
              bytes,
              imageCommitMessage(imagePath),
            );
            const image: ImageAsset = {
              path: imagePath,
              name: safeName,
              size: bytes.byteLength,
              mimeType,
              sha: deploymentId,
              updatedAt: null,
            };
            return json({ success: true, image, error: null }, 201);
          }
        } catch (error) {
          return mapDeployError(error, {
            code: 'deploy_error',
            message: 'Hosting platform request failed',
            status: 502,
          });
        }


        // A re-upload with the same filename must REPLACE the blob: look up
        // the current sha from the default-branch tree so the contents PUT
        // becomes an update instead of a 422 "sha was not provided". A
        // missing tree (empty repo, first upload) is non-fatal; a truncated
        // tree propagates so the caller sees the repo-size error instead of
        // an opaque 422→502.
        let existingSha: string | null = null;
        try {
          const tree = await client.listTree(decodeSegment(owner), decodeSegment(repo), 'HEAD');
          existingSha =
            tree.find((item) => item.type === 'blob' && item.path === imagePath)?.sha ?? null;
        } catch (error) {
          if (error instanceof TreeTruncatedError) throw error;
          // Missing tree (empty repo, first upload) — create path.
        }

        const image = await client.uploadImage(
          decodeSegment(owner),
          decodeSegment(repo),
          imagePath,
          bytes,
          mimeType,
          imageCommitMessage(imagePath),
          existingSha,
        );

        return json({ success: true, image, error: null }, 201);
      } catch (error) {
        return fail(error, { code: 'github_error', message: 'Failed to upload the image', status: 502 });
      }
    }

    return jsonError('not_found', 'Repository route not found', 404);
  },
};