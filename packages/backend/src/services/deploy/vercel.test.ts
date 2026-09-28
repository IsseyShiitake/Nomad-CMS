/**
 * Tests for the Vercel API client.
 *
 * Verifies team scoping on every URL, project normalization (link → repo +
 * mode, latestDeployments → live URL), pagination walking, the direct-mode
 * file tree flattening, SHA-1 upload headers, the deployment manifest body,
 * and the error paths (401, 404).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { VercelClient } from './vercel';
import { PlatformError } from './http';

const TOKEN = 'vercel-secret-token';
const TEAM = 'team_abc';

/** Minimal Vercel project fixture. */
function vcProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'prj_1',
    name: 'site',
    // Fixed timestamps: 1754048000000 = 2025-08-01T11:33:20.000Z,
    // 1754134400000 = 2025-08-02T11:33:20.000Z.
    createdAt: 1754048000000,
    updatedAt: 1754134400000,
    link: { type: 'github', org: 'octocat', repo: 'site', productionBranch: 'main' },
    latestDeployments: [
      {
        id: 'dpl_1',
        url: 'site.vercel.app',
        readyState: 'READY',
        target: 'production',
        createdAt: 1754134400000,
        meta: { githubCommitMessage: 'CMS: Updated index.html' },
      },
    ],
    ...overrides,
  };
}

/** Builds a JSON response. */
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('VercelClient', () => {
  let client: VercelClient;
  let fetchSpy: Mock;

  beforeEach(() => {
    client = new VercelClient(TOKEN, TEAM);
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('scopes every request with the teamId query parameter', async () => {
    fetchSpy.mockResolvedValue(json({ projects: [], pagination: {} }));

    await client.listProjects();

    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      `https://api.vercel.com/v10/projects?limit=100&teamId=${TEAM}`,
    );
    expect(fetchSpy.mock.calls[0]![1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('omits the team scope for personal tokens', async () => {
    const personal = new VercelClient(TOKEN, null);
    fetchSpy.mockResolvedValue(json({ projects: [], pagination: {} }));

    await personal.listProjects();

    expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://api.vercel.com/v10/projects?limit=100');
  });

  it('normalizes git projects with repo, branch, and live URL', async () => {
    fetchSpy.mockResolvedValue(json({ projects: [vcProject()], pagination: {} }));

    const projects = await client.listProjects();

    expect(projects).toEqual([
      {
        platform: 'vercel',
        name: 'site',
        id: 'prj_1',
        mode: 'git',
        repo: 'octocat/site',
        url: 'https://site.vercel.app',
        updatedAt: '2025-08-02T11:33:20.000Z',
        latest: {
          id: 'dpl_1',
          state: 'success',
          url: 'https://site.vercel.app',
          message: 'CMS: Updated index.html',
          createdAt: '2025-08-02T11:33:20.000Z',
        },
      },
    ]);
  });

  it('classifies projects without a Git link as direct mode', async () => {
    fetchSpy.mockResolvedValue(json({ projects: [vcProject({ link: null })], pagination: {} }));

    const [project] = await client.listProjects();
    expect(project!.mode).toBe('direct');
    expect(project!.repo).toBeNull();
  });

  it('walks pagination until the continuation token is exhausted', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        json({
          projects: [vcProject({ id: 'prj_1' })],
          pagination: { next: 'cursor-2' },
        }),
      )
      .mockResolvedValueOnce(
        json({
          projects: [vcProject({ id: 'prj_2', name: 'other', link: null })],
          pagination: {},
        }),
      );

    const projects = await client.listProjects();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[1]![0])).toContain('from=cursor-2');
    expect(projects.map((p) => p.id)).toEqual(['prj_1', 'prj_2']);
  });

  it('verifies the token and resolves account + team names', async () => {
    fetchSpy
      .mockResolvedValueOnce(json({ user: { username: 'octo', name: 'Octo Cat' } }))
      .mockResolvedValueOnce(
        json({ teams: [{ id: 'other', name: 'Other' }, { id: TEAM, name: 'My Team' }] }),
      );

    const result = await client.verify();

    expect(result).toEqual({ accountName: 'Octo Cat', teamName: 'My Team' });
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      `https://api.vercel.com/v2/user?teamId=${TEAM}`,
    );
  });

  it('deploys from a Git source with the full repo coordinates', async () => {
    fetchSpy.mockResolvedValue(
      json({
        id: 'dpl_2',
        url: 'site-xyz.vercel.app',
        readyState: 'QUEUED',
        target: 'production',
        createdAt: 1754200000000,
      }),
    );

    const summary = await client.deployGit('site', 'octocat', 'site', 'main', 'CMS: publish');

    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      `https://api.vercel.com/v13/deployments?teamId=${TEAM}`,
    );
    expect(JSON.parse(fetchSpy.mock.calls[0]![1].body)).toEqual({
      name: 'site',
      target: 'production',
      gitSource: { type: 'github', org: 'octocat', repo: 'site', ref: 'main' },
      meta: { githubCommitMessage: 'CMS: publish' },
    });
    expect(summary.state).toBe('queued');
    expect(summary.url).toBe('https://site-xyz.vercel.app');
  });

  it('flattens a nested deployment file tree into path entries', async () => {
    fetchSpy.mockResolvedValue(
      json([
        {
          name: 'index.html',
          type: 'file',
          uid: 'uid-1',
        },
        {
          name: 'assets',
          type: 'directory',
          children: [
            { name: 'style.css', type: 'file', uid: 'uid-2' },
            { name: 'img', type: 'directory', children: [{ name: 'hero.png', type: 'file', uid: 'uid-3' }] },
          ],
        },
      ]),
    );

    const files = await client.listDeploymentFiles('dpl_1');

    expect(files).toEqual([
      { path: 'index.html', name: 'index.html', type: 'file', size: 0 },
      { path: 'assets', name: 'assets', type: 'dir', size: 0 },
      { path: 'assets/style.css', name: 'style.css', type: 'file', size: 0 },
      { path: 'assets/img', name: 'img', type: 'dir', size: 0 },
      { path: 'assets/img/hero.png', name: 'hero.png', type: 'file', size: 0 },
    ]);
  });

  it('uploads a file with digest and size headers', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 200 }));

    const bytes = new TextEncoder().encode('<p>hello</p>');
    await client.uploadFile(bytes, 'abc123');

    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      `https://api.vercel.com/v2/files?teamId=${TEAM}`,
    );
    expect(fetchSpy.mock.calls[0]![1].headers['x-vercel-digest']).toBe('abc123');
    expect(fetchSpy.mock.calls[0]![1].headers['x-vercel-size']).toBe('12');
  });

  it('creates a direct deployment from the uploaded manifest', async () => {
    fetchSpy.mockResolvedValue(
      json({
        id: 'dpl_3',
        url: 'site-2.vercel.app',
        readyState: 'INITIALIZING',
        target: 'production',
        createdAt: 1754300000000,
      }),
    );

    const summary = await client.deployDirect(
      'site',
      [{ file: 'index.html', sha: 'abc123', size: 13 }],
      'CMS: publish',
    );

    expect(JSON.parse(fetchSpy.mock.calls[0]![1].body)).toEqual({
      name: 'site',
      target: 'production',
      files: [{ file: 'index.html', sha: 'abc123', size: 13 }],
      meta: { githubCommitMessage: 'CMS: publish' },
    });
    expect(summary.state).toBe('building');
  });

  it('returns null from getProject on 404', async () => {
    fetchSpy.mockResolvedValue(new Response('not found', { status: 404 }));

    expect(await client.getProject('missing')).toBeNull();
  });

  it('surfaces a 401 as a PlatformError for the route to map', async () => {
    fetchSpy.mockResolvedValue(new Response('unauthorized', { status: 401 }));

    await expect(client.listProjects()).rejects.toBeInstanceOf(PlatformError);
  });

  it('extracts the error message from a Vercel error body', async () => {
    fetchSpy.mockResolvedValue(
      json({ error: { code: 'forbidden', message: 'token lacks scope' }, status: 403 }, 403),
    );

    const promise = client.listProjects();
    await expect(promise).rejects.toMatchObject({
      status: 403,
      detail: 'token lacks scope',
    });
  });
});
