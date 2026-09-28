/**
 * Cloudflare Pages API client.
 *
 * Talks to the Cloudflare REST API (api.cloudflare.com/client/v4) scoped to
 * one account's Pages projects. The API token is bound to this client
 * instance and only ever sent in the Authorization header.
 *
 * Cloudflare Pages has no per-file read/write API: projects are Git-connected
 * (source.config.repo_name) and deployments rebuild the branch HEAD. This
 * client therefore exposes project discovery, deployment triggering, and
 * deployment status — the publish pipeline. File editing remains GitHub's
 * job.
 */

import type { DeployProject, DeployState, DeploySummary } from '@cms/shared';
import { PlatformError, PlatformRateLimitError, platformRequest } from './http';

/** Cloudflare API envelope: every response nests its payload under `result`. */
interface CfEnvelope<T> {
  success: boolean;
  result: T;
}

/** Cloudflare Pages project object (subset the CMS uses). */
interface CfProject {
  id: string;
  name: string;
  subdomain: string | null;
  domains: string[];
  created_on: string;
  canonical_deployment: CfDeployment | null;
  source: {
    type?: string;
    config?: {
      owner?: string;
      repo_name?: string;
      production_branch?: string | null;
    } | null;
  } | null;
}

/** Cloudflare Pages deployment object (subset the CMS uses). */
interface CfDeployment {
  id: string;
  url: string | null;
  created_on: string | null;
  commit_message: string | null;
  latest_stage: { name: string; status: string } | null;
  environment: 'production' | 'preview';
}

/** Normalizes a Cloudflare stage status into the shared DeployState. */
function mapStageStatus(deployment: CfDeployment): DeployState {
  const stage = deployment.latest_stage;
  if (!stage) return 'unknown';
  switch (stage.status) {
    case 'success':
      return 'success';
    case 'active':
      // Queued/initialize stages mean the build has not finished yet.
      return stage.name === 'queued' ? 'queued' : 'building';
    case 'failure':
      return 'error';
    case 'canceled':
      return 'canceled';
    default:
      return 'unknown';
  }
}

/** Normalizes a Cloudflare host/URL to a full https:// URL.
 * Cloudflare returns bare hostnames (e.g. "site.pages.dev", deployment
 * urls); the shared DeployProject/DeploySummary contract expects the
 * scheme so frontend hrefs and `new URL()` keep working. */
function withScheme(url: string | null): string | null {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/** Maps a Cloudflare deployment to the shared summary shape. */
function mapDeployment(deployment: CfDeployment): DeploySummary {
  return {
    id: deployment.id,
    state: mapStageStatus(deployment),
    url: withScheme(deployment.url),
    message: deployment.commit_message,
    createdAt: deployment.created_on,
  };
}

/** Maps a Cloudflare Pages project to the shared DeployProject shape. */
function mapProject(project: CfProject): DeployProject {
  const config = project.source?.config ?? null;
  const repo =
    config?.owner && config?.repo_name ? `${config.owner}/${config.repo_name}` : null;
  // Cloudflare Pages projects are Git-connected by construction (there is no
  // direct-upload mode accessible via this API surface).
  return {
    platform: 'cloudflare',
    name: project.name,
    id: project.id,
    mode: 'git',
    repo,
    url: withScheme(
      project.domains[0] ?? (project.subdomain ? `${project.subdomain}.pages.dev` : null),
    ),
    updatedAt: project.created_on,
    latest: project.canonical_deployment ? mapDeployment(project.canonical_deployment) : null,
  };
}

/**
 * Cloudflare Pages client bound to one API token + account id.
 *
 * All requests are scoped to `accounts/{accountId}/pages/*`; the account id
 * is validated at connect time (listing projects 404s for a wrong id).
 */
export class CloudflarePagesClient {
  private static readonly API_BASE = 'https://api.cloudflare.com/client/v4';

  constructor(
    private readonly token: string,
    private readonly accountId: string,
  ) {}

  /** Performs an account-scoped Cloudflare request, unwrapping the envelope. */
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const envelope = await platformRequest<CfEnvelope<T>>(
      `${CloudflarePagesClient.API_BASE}/accounts/${encodeURIComponent(this.accountId)}${path}`,
      this.token,
      init,
    );
    // Cloudflare answers 200 with success:false for some failures (e.g.
    // authentication errors on mis-scoped tokens) — normalize those the same
    // way as HTTP-level errors so the route maps them to 401/502.
    if (!envelope.success) {
      throw new PlatformError(502, null, 'Cloudflare API reported failure');
    }
    return envelope.result;
  }

  /** Lists every Pages project in the account (paged; 50 per page). */
  async listProjects(): Promise<DeployProject[]> {
    const out: DeployProject[] = [];
    // Page until a short page arrives (the API has no total-count field).
    // The 50-page bound guards against a misbehaving endpoint.
    for (let page = 1; page <= 50; page += 1) {
      const batch = await this.request<CfProject[]>(
        `/pages/projects?per_page=50&page=${page}`,
      );
      out.push(...batch.map(mapProject));
      if (batch.length < 50) break;
    }
    return out;
  }

  /**
   * Triggers a production deployment for a project.
   *
   * A bare POST rebuilds the production branch HEAD; Cloudflare rejects it
   * when the project has no Git source, in which case the CMS surfaces a
   * clear error (Cloudflare has no direct-file mode for such projects).
   */
  async deploy(name: string, commitMessage: string): Promise<DeploySummary> {
    const deployment = await this.request<CfDeployment>(
      `/pages/projects/${encodeURIComponent(name)}/deployments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commit_message: commitMessage }),
      },
    );
    return mapDeployment(deployment);
  }

  /** Cheap token/account probe: listing a single project verifies the pair
   * as well as a full listing would (connect-time check only). */
  async verify(): Promise<boolean> {
    await this.request<CfProject[]>('/pages/projects?per_page=1&page=1');
    return true;
  }
}

export { PlatformError, PlatformRateLimitError };
