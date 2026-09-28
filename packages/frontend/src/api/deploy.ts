import { apiRequest } from './client';
import type {
  DeployConnection,
  DeployLink,
  DeployPlatform,
  DeployProject,
  PublishResult,
} from '@cms/shared';

/**
 * Deploy API endpoints.
 *
 * Hosting-platform interactions are proxied through the backend so platform
 * API tokens never reach the frontend. Connections are managed by admins;
 * publishing uses the admin's stored tokens server-side.
 */

/** Lists the admin's platform connections (tokens never included). */
export async function listDeployConnections(): Promise<DeployConnection[]> {
  return apiRequest<DeployConnection[]>('/api/deploy/connections', {});
}

/** Connects (or replaces) a platform; the token is sent once, never returned. */
export async function connectPlatform(
  platform: DeployPlatform,
  token: string,
  accountId: string | null,
): Promise<DeployConnection> {
  return apiRequest<DeployConnection>(
    `/api/deploy/connections/${encodeURIComponent(platform)}`,
    {
      method: 'POST',
      body: JSON.stringify({ token, ...(accountId ? { accountId } : {}) }),
    },
  );
}

/** Disconnects a platform. */
export async function disconnectPlatform(platform: DeployPlatform): Promise<void> {
  await apiRequest<{ success: boolean }>(
    `/api/deploy/connections/${encodeURIComponent(platform)}`,
    { method: 'DELETE' },
  );
}

/** Lists every connected platform's projects (admin only). */
export async function listDeployProjects(): Promise<DeployProject[]> {
  return apiRequest<DeployProject[]>('/api/deploy/projects', {});
}

/** Resolves the platform projects publishing one repository. */
export async function getDeployLinks(
  owner: string,
  repo: string,
): Promise<DeployLink[]> {
  return apiRequest<DeployLink[]>(
    `/api/deploy/links/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    {},
  );
}

/** Trigger and result shape for publish(). */
export interface PublishOutcome {
  deployments: PublishResult[];
  failures: Array<{ platform: DeployPlatform; error: string }>;
}

/** Triggers production deployments for every project linked to the repo. */
export async function publishRepository(
  owner: string,
  repo: string,
): Promise<PublishOutcome> {
  return apiRequest<PublishOutcome>(
    `/api/deploy/links/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/publish`,
    { method: 'POST' },
  );
}

/** Fetches the latest deployment state for every linked project. */
export async function getDeployStatus(
  owner: string,
  repo: string,
): Promise<Array<{ platform: DeployPlatform; projectName: string; latest: DeployLink['latest'] }>> {
  return apiRequest<Array<{ platform: DeployPlatform; projectName: string; latest: DeployLink['latest'] }>>(
    `/api/deploy/links/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/status`,
    {},
  );
}
