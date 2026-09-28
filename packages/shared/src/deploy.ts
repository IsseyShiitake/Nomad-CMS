/**
 * Hosting-platform (deploy) domain types.
 *
 * The CMS edits site files in a GitHub repository and publishes them to a
 * hosting platform — Cloudflare Pages or Vercel. These types normalize both
 * platforms' projects and deployments into one shape the frontend renders,
 * and define the connection records the Worker stores per administrator.
 *
 * Two hosting modes exist:
 *  - "git"    — the platform project is connected to a GitHub repository; the
 *               CMS commits via GitHub and triggers a rebuild deployment.
 *  - "direct" — Vercel-only: the project has no Git repository; files live
 *               exclusively on Vercel and every save is a fresh deployment.
 */

/** Supported hosting platforms. */
export type DeployPlatform = 'cloudflare' | 'vercel';

/** How a platform project stores the site's files. */
export type HostingMode = 'git' | 'direct';

/** Normalized deployment lifecycle state across platforms. */
export type DeployState =
  | 'queued'
  | 'building'
  | 'success'
  | 'error'
  | 'canceled'
  | 'unknown';

/** A normalized hosting-platform project the CMS can publish to. */
export interface DeployProject {
  /** Platform this project lives on. */
  platform: DeployPlatform;

  /** Platform project name (unique per account/team). */
  name: string;

  /** Platform project id. */
  id: string;

  /** How files are stored for this project. */
  mode: HostingMode;

  /** For git-mode projects: the connected repository ("owner/name"), else null. */
  repo: string | null;

  /** The project's live URL (first custom domain or platform subdomain). */
  url: string | null;

  /** When the project was last updated (ISO timestamp), when known. */
  updatedAt: string | null;

  /** Latest production deployment summary, when one exists. */
  latest: DeploySummary | null;
}

/** A normalized deployment on a hosting platform. */
export interface DeploySummary {
  /** Platform deployment id. */
  id: string;

  /** Normalized state. */
  state: DeployState;

  /** Live URL of this specific deployment, when known. */
  url: string | null;

  /** Human-readable commit message associated with the deployment. */
  message: string | null;

  /** When the deployment was created (ISO timestamp), when known. */
  createdAt: string | null;
}

/** A repository↔platform-project link resolved for one repository. */
export interface DeployLink {
  platform: DeployPlatform;
  /** Platform project name — the identifier used for publish calls. */
  projectName: string;
  mode: HostingMode;
  /** Live URL of the linked project, when known. */
  url: string | null;
  /** Latest production deployment of the linked project, when known. */
  latest: DeploySummary | null;
}
export interface DeployConnection {
  platform: DeployPlatform;
  /** Account/owner display name on the platform. */
  accountName: string | null;
  /** Platform account/team identifier used for API calls. */
  accountId: string | null;
  /** ISO timestamp when the connection was created. */
  createdAt: string;
  /** ISO timestamp of the last successful API call through this connection. */
  lastUsedAt: string | null;
  /** True when the last call failed with an authorization error. */
  tokenInvalid: boolean;
  /** How the connection was established: pasted API token or OAuth login. */
  source?: 'token' | 'oauth';
  /** ISO timestamp when the OAuth access token expires (OAuth only). */
  tokenExpiresAt?: string | null;
}

/** Whether one platform's OAuth login is configured on the Worker. */
export interface PlatformOAuthStatus {
  platform: DeployPlatform;
  /** True when the Worker holds the platform's OAuth client credentials. */
  available: boolean;
}

/** Result of a publish (deployment trigger) call. */
export interface PublishResult {
  /** Platform the deployment was triggered on. */
  platform: DeployPlatform;

  /** Platform project name the deployment belongs to. */
  projectName: string;

  /** Platform deployment id. */
  deploymentId: string;

  /** Initial normalized state. */
  state: DeployState;
}

/** A file entry inside a Vercel direct-upload project's latest deployment. */
export interface DirectFileEntry {
  /** Path relative to the project root. */
  path: string;

  /** File name (last path segment). */
  name: string;

  /** 'file' | 'dir'. */
  type: 'file' | 'dir';

  /** Size in bytes when known. */
  size: number;
}
