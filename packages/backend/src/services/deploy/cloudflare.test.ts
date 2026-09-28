/**
 * Tests for the Cloudflare Pages API client.
 *
 * Verifies the account-scoped request URLs, the envelope unwrapping, the
 * project/deployment normalization (Git source → repo + branch, stage
 * status → DeployState), and the error paths (401, 404, rate limit).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CloudflarePagesClient } from './cloudflare';
import { PlatformError, PlatformRateLimitError } from './http';

const ACCOUNT = 'acc-1234';
const TOKEN = 'cf-secret-token';

/** Minimal Cloudflare Pages project fixture. */
function cfProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p1',
    name: 'site',
    subdomain: 'site-abc',
    domains: [],
    created_on: '2026-08-01T00:00:00Z',
    canonical_deployment: {
      id: 'd1',
      url: 'https://site-abc.pages.dev',
      created_on: '2026-08-02T00:00:00Z',
      commit_message: 'CMS: Updated index.html',
      latest_stage: { name: 'deploy', status: 'success' },
      environment: 'production',
    },
    source: {
      type: 'github',
      config: { owner: 'octocat', repo_name: 'site', production_branch: 'main' },
    },
    ...overrides,
  };
}

/** Builds a Cloudflare envelope response. */
function envelope(result: unknown, success = true): Response {
  return new Response(JSON.stringify({ success, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CloudflarePagesClient', () => {
  let client: CloudflarePagesClient;
  let fetchSpy: Mock;

  beforeEach(() => {
    client = new CloudflarePagesClient(TOKEN, ACCOUNT);
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists projects with account-scoped URLs and normalized fields', async () => {
    fetchSpy.mockResolvedValue(envelope([cfProject()]));

    const projects = await client.listProjects();

    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/pages/projects?per_page=50&page=1`,
    );
    expect(fetchSpy.mock.calls[0]![1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(projects).toEqual([
      {
        platform: 'cloudflare',
        name: 'site',
        id: 'p1',
        mode: 'git',
        repo: 'octocat/site',
        url: 'https://site-abc.pages.dev',
        updatedAt: '2026-08-01T00:00:00Z',
        latest: {
          id: 'd1',
          state: 'success',
          url: 'https://site-abc.pages.dev',
          message: 'CMS: Updated index.html',
          createdAt: '2026-08-02T00:00:00Z',
        },
      },
    ]);
  });

  it('prefers the first custom domain over the pages.dev subdomain (scheme added)', async () => {
    fetchSpy.mockResolvedValue(
      envelope([cfProject({ domains: ['example.com'], subdomain: 'site-abc' })]),
    );

    const [project] = await client.listProjects();
    expect(project!.url).toBe('https://example.com');
  });

  it('maps an in-flight build stage to "building"', async () => {
    fetchSpy.mockResolvedValue(
      envelope([
        cfProject({
          canonical_deployment: {
            id: 'd1',
            url: null,
            created_on: null,
            commit_message: null,
            latest_stage: { name: 'build', status: 'active' },
            environment: 'production',
          },
        }),
      ]),
    );

    const [project] = await client.listProjects();
    expect(project!.latest!.state).toBe('building');
  });

  it('maps a queued deployment to "queued"', async () => {
    fetchSpy.mockResolvedValue(
      envelope([
        cfProject({
          canonical_deployment: {
            id: 'd1',
            url: null,
            created_on: null,
            commit_message: null,
            latest_stage: { name: 'queued', status: 'active' },
            environment: 'production',
          },
        }),
      ]),
    );

    const [project] = await client.listProjects();
    expect(project!.latest!.state).toBe('queued');
  });

  it('treats a project with no Git source config as repo-less', async () => {
    fetchSpy.mockResolvedValue(envelope([cfProject({ source: { type: 'github', config: null } })]));

    const [project] = await client.listProjects();
    expect(project!.repo).toBeNull();
    expect(project!.mode).toBe('git');
  });

  it('triggers a deployment with a POST carrying the commit message', async () => {
    fetchSpy.mockResolvedValue(
      envelope({
        id: 'd2',
        url: null,
        created_on: '2026-08-03T00:00:00Z',
        commit_message: null,
        latest_stage: { name: 'queued', status: 'active' },
        environment: 'production',
      }),
    );

    const summary = await client.deploy('site', 'CMS: Updated index.html');

    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/pages/projects/site/deployments`,
    );
    expect(fetchSpy.mock.calls[0]![1].method).toBe('POST');
    expect(JSON.parse(fetchSpy.mock.calls[0]![1].body)).toEqual({
      commit_message: 'CMS: Updated index.html',
    });
    expect(summary.state).toBe('queued');
  });

  it('verifies with a single-project probe', async () => {
    fetchSpy.mockResolvedValue(envelope([]));

    await expect(client.verify()).resolves.toBe(true);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/pages/projects?per_page=1&page=1`,
    );
  });

  it('surfaces a 401 as a PlatformError for the route to map', async () => {
    fetchSpy.mockResolvedValue(new Response('unauthorized', { status: 401 }));

    await expect(client.listProjects()).rejects.toMatchObject({
      constructor: PlatformError,
      status: 401,
    });
  });

  it('surfaces a 429 as a PlatformRateLimitError with Retry-After', async () => {
    fetchSpy.mockResolvedValue(
      new Response('too many requests', {
        status: 429,
        headers: { 'Retry-After': '30' },
      }),
    );

    await expect(client.listProjects()).rejects.toMatchObject({
      constructor: PlatformRateLimitError,
      retryAfter: 30,
    });
  });

  it('throws on an envelope with success:false', async () => {
    fetchSpy.mockResolvedValue(envelope([], false));

    await expect(client.listProjects()).rejects.toThrow('Cloudflare API reported failure');
  });
});
