/**
 * Vercel API client.
 *
 * Talks to api.vercel.com scoped to one access token and optional team id.
 * Vercel projects come in two hosting modes:
 *
 *  - "git"    — connected to a GitHub repository (link.org/link.repo); the
 *               CMS publishes by triggering a deployment from the Git ref.
 *  - "direct" — no Git repository; files live only on Vercel. The CMS reads
 *               the latest deployment's file tree, edits in memory, and
 *               saves by uploading every changed file (POST /v2/files with
 *               SHA-1 digests) and creating a new deployment that references
 *               the full file manifest.
 *
 * The token is bound to this client instance and only ever sent in the
 * Authorization header; team scoping rides the query string.
 */

import type {
  DeployProject,
  DeployState,
  DeploySummary,
  DirectFileEntry,
} from '@cms/shared';
import { PlatformError, PlatformRateLimitError, platformRequest, PLATFORM_TIMEOUT_MS } from './http';

/** Vercel project object (subset the CMS uses). */
interface VercelProject {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  link: {
    type?: string;
    org?: string;
    repo?: string;
    productionBranch?: string;
  } | null;
  latestDeployments: VercelDeployment[];
  // First custom domain, else the platform-generated project domain.
  targets?: Record<string, { id?: string; alias?: string[] } | undefined>;
}

/** Vercel deployment object (subset the CMS uses). */
interface VercelDeployment {
  id: string;
  url: string;
  readyState: string;
  target: 'production' | null;
  createdAt: number;
  meta?: Record<string, string>;
}

/** File-tree entry from GET /v6/deployments/{id}/files. */
interface VercelTreeEntry {
  name: string;
  type: 'directory' | 'file' | 'invalid' | 'lambda' | 'middleware' | 'symlink';
  uid?: string;
  /** File size when the API provides it (not in the documented schema —
   * tolerated so the file browser shows real sizes the day Vercel adds it). */
  size?: number;
  children?: VercelTreeEntry[];
}

/** Normalizes a Vercel readyState into the shared DeployState. */
function mapReadyState(state: string): DeployState {
  switch (state) {
    case 'READY':
      return 'success';
    case 'QUEUED':
      return 'queued';
    case 'INITIALIZING':
    case 'BUILDING':
      return 'building';
    case 'ERROR':
      return 'error';
    case 'CANCELED':
      return 'canceled';
    default:
      return 'unknown';
  }
}

/** Maps a Vercel deployment to the shared summary shape. */
function mapDeployment(deployment: VercelDeployment): DeploySummary {
  return {
    id: deployment.id,
    state: mapReadyState(deployment.readyState),
    // Vercel URLs omit the scheme.
    url: deployment.url ? `https://${deployment.url}` : null,
    message: deployment.meta?.githubCommitMessage ?? null,
    createdAt: deployment.createdAt
      ? new Date(deployment.createdAt).toISOString()
      : null,
  };
}

/** Maps a Vercel project to the shared DeployProject shape. */
function mapProject(project: VercelProject): DeployProject {
  const link = project.link;
  const repo = link?.org && link?.repo ? `${link.org}/${link.repo}` : null;
  const latestProduction = project.latestDeployments.find((d) => d.target === 'production');
  return {
    platform: 'vercel',
    name: project.name,
    id: project.id,
    mode: repo ? 'git' : 'direct',
    repo,
    // The newest deployment's URL doubles as the project's live URL until a
    // custom alias is assigned; latestDeployments[0] is the most recent build.
    url: project.latestDeployments[0] ? `https://${project.latestDeployments[0].url}` : null,
    updatedAt: project.updatedAt
      ? new Date(project.updatedAt).toISOString()
      : null,
    latest: latestProduction ? mapDeployment(latestProduction) : null,
  };
}

/**
 * Vercel client bound to one access token and optional team scope.
 *
 * The team id rides every request's query string (Vercel's team scoping
 * model); when null the token's own account is used.
 */
export class VercelClient {
  private static readonly API_BASE = 'https://api.vercel.com';

  constructor(
    private readonly token: string,
    private readonly teamId: string | null,
  ) {}

  /** Appends the team scope to a Vercel query string. */
  private scope(path: string): string {
    if (!this.teamId) return path;
    return path.includes('?') ? `${path}&teamId=${encodeURIComponent(this.teamId)}` : `${path}?teamId=${encodeURIComponent(this.teamId)}`;
  }

  /** Performs a team-scoped Vercel request. */
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return platformRequest<T>(`${VercelClient.API_BASE}${this.scope(path)}`, this.token, init);
  }

  /** Lists every project in the team scope (paged). */
  async listProjects(): Promise<DeployProject[]> {
    const out: DeployProject[] = [];
    let from: string | undefined;
    // Vercel paginates with continuation tokens; loop until exhausted. The
    // 100-limit guard prevents a runaway loop against a misbehaving API.
    for (let page = 0; page < 100; page += 1) {
      const suffix = from ? `?from=${encodeURIComponent(from)}&limit=100` : '?limit=100';
      const data = await this.request<{ projects: VercelProject[]; pagination?: { next?: string } }>(
        `/v10/projects${suffix}`,
      );
      out.push(...data.projects.map(mapProject));
      if (!data.pagination?.next || data.projects.length === 0) break;
      from = data.pagination.next;
    }
    return out;
  }

  /** Fetches one project by name or id, or null when Vercel answers 404. */
  async getProject(nameOrId: string): Promise<DeployProject | null> {
    try {
      const project = await this.request<VercelProject>(
        `/v9/projects/${encodeURIComponent(nameOrId)}`,
      );
      return mapProject(project);
    } catch (error) {
      if (error instanceof PlatformError && error.status === 404) return null;
      throw error;
    }
  }

  /** Verifies the token and resolves the account display name. */
  async verify(): Promise<{ accountName: string | null; teamName: string | null }> {
    const user = await this.request<{ user: { username: string; name: string } }>('/v2/user');
    let teamName: string | null = null;
    if (this.teamId) {
      const teams = await this.request<{ teams: Array<{ id: string; name: string }> }>('/v2/teams');
      teamName = teams.teams.find((t) => t.id === this.teamId)?.name ?? null;
    }
    return {
      accountName: user.user.name || user.user.username,
      teamName,
    };
  }

  /**
   * Triggers a production deployment from the project's Git source.
   *
   * `org`/`repo` name the GitHub repository Vercel should build from; `ref`
   * is the branch to build (Vercel uses the project's production branch
   * when omitted, so the caller passes the repo's actual branch).
   */
  async deployGit(
    project: string,
    org: string,
    repo: string,
    ref: string,
    commitMessage: string,
  ): Promise<DeploySummary> {
    const deployment = await this.request<VercelDeployment>('/v13/deployments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: project,
        target: 'production',
        gitSource: { type: 'github', org, repo, ref },
        meta: { githubCommitMessage: commitMessage },
      }),
    });
    return mapDeployment(deployment);
  }

  /**
   * Lists the file entries of a deployment (the direct-mode file browser).
   *
   * GET /v6/deployments/{id}/files returns a nested tree; this flattens it
   * into the shared DirectFileEntry shape with repo-relative paths.
   */
  async listDeploymentFiles(deploymentId: string): Promise<DirectFileEntry[]> {
    const tree = await this.request<VercelTreeEntry[]>(
      `/v6/deployments/${encodeURIComponent(deploymentId)}/files`,
    );
    const out: DirectFileEntry[] = [];
    const walk = (entries: VercelTreeEntry[], prefix: string): void => {
      for (const entry of entries) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.type === 'directory') {
          out.push({ path, name: entry.name, type: 'dir', size: 0 });
          if (entry.children) walk(entry.children, path);
        } else if (entry.type === 'file') {
          out.push({ path, name: entry.name, type: 'file', size: entry.size ?? 0 });
        }
      }
    };
    walk(tree, '');
    return out;
  }

  /**
   * Reads one file's content from a deployment (GET /v8/.../files/{fileId}).
   *
   * The documented response is a JSON body with base64 `data`; the endpoint
   * has also been observed serving raw bytes with a content-type header. To
   * be robust against both, a JSON body is decoded from its `data`, and any
   * other body is treated as raw bytes.
   */
  async readDeploymentFile(deploymentId: string, fileId: string): Promise<Uint8Array> {
    const response = await fetch(
      `${VercelClient.API_BASE}${this.scope(`/v8/deployments/${encodeURIComponent(deploymentId)}/files/${encodeURIComponent(fileId)}`)}`,
      {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      if (response.status === 429) {
        const retryHeader = response.headers.get('Retry-After');
        const parsed = retryHeader ? Number.parseInt(retryHeader, 10) : NaN;
        throw new PlatformRateLimitError(Number.isFinite(parsed) ? parsed : null);
      }
      throw new PlatformError(response.status, null, `Vercel file read ${response.status}`);
    }
    const contentType = (response.headers.get('Content-Type') ?? '').toLowerCase();
    const raw = new Uint8Array(await response.arrayBuffer());
    if (contentType.includes('application/json')) {
      const body = JSON.parse(new TextDecoder().decode(raw)) as { data?: string };
      if (body?.data) {
        const clean = body.data.replace(/\s/g, '');
        const binary = atob(clean);
        return Uint8Array.from(binary, (char) => char.charCodeAt(0));
      }
    }
    return raw;
  }

  /** Finds the uid of a file in a deployment tree by path, or null. */
  private async findFileUid(deploymentId: string, path: string): Promise<string | null> {
    const tree = await this.request<VercelTreeEntry[]>(
      `/v6/deployments/${encodeURIComponent(deploymentId)}/files`,
    );
    const segments = path.split('/');
    let entries = tree;
    let uid: string | null = null;
    for (let i = 0; i < segments.length; i += 1) {
      const match = entries.find((entry) => entry.name === segments[i]);
      if (!match) return null;
      if (i === segments.length - 1) {
        uid = match.uid ?? null;
      } else {
        entries = match.children ?? [];
      }
    }
    return uid;
  }
  /**
   * Uploads one file for a future deployment (POST /v2/files).
   *
   * The digest is the hex SHA-1 of the bytes — Vercel's content-addressed
   * store deduplicates unchanged files across deployments. The octet-stream
   * body carries the raw bytes; headers must NOT include Content-Type: json.
   */
  async uploadFile(bytes: Uint8Array, sha1Hex: string): Promise<void> {
    const url = `${VercelClient.API_BASE}${this.scope('/v2/files')}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/octet-stream',
        'x-vercel-digest': sha1Hex,
        'x-vercel-size': String(bytes.byteLength),
      },
      body: bytes,
      signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
    });
    if (!response.ok) {
      if (response.status === 429) {
        const retryHeader = response.headers.get('Retry-After');
        const parsed = retryHeader ? Number.parseInt(retryHeader, 10) : NaN;
        throw new PlatformRateLimitError(Number.isFinite(parsed) ? parsed : null);
      }
      throw new PlatformError(
        response.status,
        null,
        `Vercel file upload ${response.status}`,
      );
    }
  }

  /**
   * Creates a direct-upload production deployment from a full file manifest.
   *
   * `files` references every project path; entries uploaded in this cycle
   * carry their SHA-1 digest and size, while unchanged files may reference
   * by path alone (Vercel resolves them from the previous deployment).
   */
  async deployDirect(
    project: string,
    files: Array<{ file: string; sha?: string; size?: number }>,
    commitMessage: string,
  ): Promise<DeploySummary> {
    const deployment = await this.request<VercelDeployment>('/v13/deployments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: project,
        target: 'production',
        files,
        meta: { githubCommitMessage: commitMessage },
      }),
    });
    return mapDeployment(deployment);
  }


  /** File id lookup exposed for the direct-mode save flow. */
  async deploymentFileUid(deploymentId: string, path: string): Promise<string | null> {
    return this.findFileUid(deploymentId, path);
  }
}

export { PlatformError, PlatformRateLimitError };
