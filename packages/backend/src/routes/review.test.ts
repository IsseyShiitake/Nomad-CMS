/**
 * Tests for the review workflow (approval mode).
 *
 * Covers: the per-access approval toggle; a client save in review mode
 * landing on the cms/<clientId> branch with an open pull request (and the
 * production branch untouched); the re-anchor cycle after a rejected pull
 * request; review-aware reads; and the admin's list / approve / reject
 * routes — with GitHub mocked at the HTTP boundary only.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Env } from '../env';
import { ClientStore, SessionManager } from '../services/auth';
import { clientsRoutes } from './clients';
import { repositoryRoutes } from './repositories';
import { reviewRoutes } from './review';
import type { RouteContext } from './index';

const KEY = 'oDUtY2LrlmkJi0/WHDoEwY9ZfUOFYaFV9qE3QBFLZ7Q=';

/** Minimal in-memory KVNamespace mock. */
function mockKv() {
  const store = new Map<string, string>();
  const kv = {
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    get: async (key: string) => store.get(key) ?? null,
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async (options: { prefix?: string }) => ({
      keys: [...store.keys()]
        .filter((key) => !options.prefix || key.startsWith(options.prefix))
        .map((name) => ({ name })),
      list_complete: true,
    }),
  } as unknown as KVNamespace;
  return { kv, store };
}

function makeEnv(kv: KVNamespace): Env {
  return {
    SESSION_KV: kv,
    ASSETS: {} as Fetcher,
    GITHUB_CLIENT_ID: 'cid',
    GITHUB_REDIRECT_URI: 'https://cms.example.com/auth/callback',
    GITHUB_CLIENT_SECRET: 'secret',
    SESSION_ENCRYPTION_KEY: KEY,
    ALLOWED_ORIGINS: '',
    OPERATOR_LOGIN: '',
  } as Env;
}

/** Unwraps the `{ data }` envelope. */
async function data<T>(response: Response): Promise<T> {
  return ((await response.json()) as { data: T }).data;
}

/** A pull request payload as GitHub returns it. */
function pr(number: number, head: string, state = 'open') {
  return {
    number,
    title: `CMS changes from ACME Corp #${number}`,
    html_url: `https://github.com/octocat/site/pull/${number}`,
    head: { ref: head },
    base: { ref: 'main' },
    updated_at: '2026-11-09T00:00:00Z',
    state,
  };
}

interface GithubState {
  /** branch name → head sha (null = missing). */
  branches: Map<string, string | null>;
  /** head branch → open PR. */
  openPulls: Map<string, ReturnType<typeof pr>>;
  closedPulls: number[];
  mergedPulls: number[];
  /** sha the contents PUT last carried (branch routing evidence). */
  writes: Array<{ path: string; branch?: string; sha: string | null }>;
}

/** Stubs global fetch with a GitHub-API router driven by `state`. */
function stubGithub(state: GithubState): Mock {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.replace('https://api.github.com', '');

    // Repository metadata (default branch for PR creation).
    if (method === 'GET' && /^\/repos\/octocat\/site$/.test(path)) {
      return json({
        id: 1,
        name: 'site',
        owner: { login: 'octocat', avatar_url: null },
        full_name: 'octocat/site',
        default_branch: 'main',
        description: null,
        private: true,
        html_url: 'https://github.com/octocat/site',
        updated_at: '2026-11-09T00:00:00Z',
      });
    }
    // Branch existence.
    const branchMatch = /^\/repos\/octocat\/site\/branches\/(.+)$/.exec(path);
    if (method === 'GET' && branchMatch) {
      const sha = state.branches.get(decodeURIComponent(branchMatch[1]!));
      return sha ? json({ commit: { sha } }) : new Response(null, { status: 404 });
    }
    // Commit sha for branch (re-)anchoring.
    if (method === 'GET' && /^\/repos\/octocat\/site\/commits\/HEAD$/.test(path)) {
      return json({ sha: 'head-sha' });
    }
    // Branch create / delete.
    if (method === 'POST' && path === '/repos/octocat/site/git/refs') {
      const ref = (init?.body ? JSON.parse(String(init.body)) : {}).ref as string;
      state.branches.set(ref.replace('refs/heads/', ''), 'head-sha');
      return json({}, 201);
    }
    const deleteRef = /^\/repos\/octocat\/site\/git\/refs\/heads\/(.+)$/.exec(path);
    if (method === 'DELETE' && deleteRef) {
      state.branches.delete(decodeURIComponent(deleteRef[1]!));
      return new Response(null, { status: 204 });
    }
    // Pull request lookup by head.
    if (method === 'GET' && path.startsWith('/repos/octocat/site/pulls')) {
      const single = /^\/repos\/octocat\/site\/pulls\/(\d+)$/.exec(path);
      if (single) {
        const found =
          [...state.openPulls.values()].find((p) => p.number === Number(single[1])) ??
          pr(Number(single[1]), 'cms/acme-corp');
        return json(found);
      }
      const headParam = new URL(url).searchParams.get('head');
      if (headParam) {
        const branch = headParam.split(':')[1] ?? '';
        const open = state.openPulls.get(branch);
        return json(open ? [open] : []);
      }
      return json([...state.openPulls.values()]);
    }
    // PR lifecycle.
    const prNumber = /^\/repos\/octocat\/site\/pulls\/(\d+)\/(merge|update-branch)$/.exec(path);
    if (prNumber && method === 'PUT') {
      if (prNumber[2] === 'update-branch') return json({ message: 'up to date' }, 202);
      state.mergedPulls.push(Number(prNumber[1]));
      state.openPulls.delete('cms/acme-corp');
      return json({ merged: true });
    }
    if (method === 'POST' && path === '/repos/octocat/site/pulls') {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const created = pr(7, body.head);
      state.openPulls.set(body.head, created);
      return json(created, 201);
    }
    const patch = /^\/repos\/octocat\/site\/pulls\/(\d+)$/.exec(path);
    if (method === 'PATCH' && patch) {
      const closed = [...state.openPulls.values()].find((p) => p.number === Number(patch[1]));
      if (closed) state.openPulls.delete(closed.head.ref);
      state.closedPulls.push(Number(patch[1]));
      return json(pr(Number(patch[1]), 'cms/acme-corp', 'closed'));
    }
    // Contents write (page save): record the branch routing.
    if (method === 'PUT' && path.startsWith('/repos/octocat/site/contents/')) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      state.writes.push({ path: path.replace('/repos/octocat/site/contents/', ''), branch: body.branch, sha: body.sha ?? null });
      return json({ content: { name: 'index.html', path: 'index.html', sha: 'new-sha', size: 10 } }, 200);
    }
    // Contents read (page load).
    if (method === 'GET' && path.startsWith('/repos/octocat/site/contents/index.html')) {
      return json({ name: 'index.html', path: 'index.html', sha: 'file-sha', size: 4, encoding: 'base64', content: btoa('<h1>Hi</h1>'), type: 'file' });
    }
    return json({ message: `unmocked ${method} ${path}` }, 500);
  });

  vi.stubGlobal('fetch', handler);
  return handler;
}

describe('review workflow', () => {
  let kv: KVNamespace;
  let ctx: RouteContext;
  let adminSession: string;
  let clientSession: string;
  let store: ClientStore;
  let github: GithubState;
  let fetchMock: Mock;

  beforeEach(async () => {
    ({ kv } = mockKv());
    ctx = { env: makeEnv(kv) };
    github = { branches: new Map(), openPulls: new Map(), closedPulls: [], mergedPulls: [], writes: [] };
    fetchMock = stubGithub(github);

    const sessions = new SessionManager(kv, KEY);
    adminSession = await sessions.createSession('ghp_admin', {
      id: 1,
      login: 'octocat',
      name: null,
      avatarUrl: null,
    });
    store = new ClientStore(kv, KEY);
    await store.create({
      clientId: 'acme-corp',
      label: 'ACME Corp',
      repo: { owner: 'octocat', repo: 'site' },
      createdBy: 'octocat',
      passwordHash: 'hash',
      salt: 'salt',
      githubToken: await store.encryptGitHubToken('ghp_admin'),
      createdAt: '2026-11-09T00:00:00Z',
      lastUsedAt: null,
      revoked: false,
      requireApproval: true,
      failedAttempts: 0,
      lockedUntil: null,
    });
    clientSession = await sessions.createClientSession(
      'ghp_admin',
      { id: 0, login: 'acme', name: 'acme', avatarUrl: null },
      { owner: 'octocat', repo: 'site' },
      'octocat',
      null,
      'acme-corp',
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function putPage(session: string) {
    return repositoryRoutes.handle(
      '/octocat/site/pages/index.html',
      new Request('http://localhost/api/repositories/octocat/site/pages/index.html', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `__Host-cms_session=${session}`,
          'X-CSRF-Token': 'test',
        },
        body: JSON.stringify({ content: '<h1>Edited</h1>', sha: 'file-sha' }),
      }),
      ctx,
    );
  }

  it('routes an approval-mode client save to a review branch with a pull request', async () => {
    const response = await putPage(clientSession);
    expect(response.status).toBe(200);
    const payload = await data<{ success: boolean; pendingApproval?: boolean; prUrl?: string }>(response);

    expect(payload.success).toBe(true);
    expect(payload.pendingApproval).toBe(true);
    expect(payload.prUrl).toBe('https://github.com/octocat/site/pull/7');

    // The write carried the review branch, not the default branch.
    expect(github.writes).toHaveLength(1);
    expect(github.writes[0]!.branch).toBe('cms/acme-corp');
    // The branch was created from the production HEAD.
    expect(github.branches.has('cms/acme-corp')).toBe(true);
    // The pull request exists and is open.
    expect(github.openPulls.get('cms/acme-corp')?.number).toBe(7);
  });

  it('reuses the open pull request on the second save', async () => {
    await putPage(clientSession);
    github.writes.length = 0;

    await putPage(clientSession);
    const createPullCalls = fetchMock.mock.calls.filter(
      ([input, init]) =>
        String(input).endsWith('/pulls') && (init?.method ?? 'GET').toUpperCase() === 'POST',
    );
    expect(github.writes[0]!.branch).toBe('cms/acme-corp');
    expect(createPullCalls).toHaveLength(1); // only the first save created it
  });

  it('re-anchors the branch from production HEAD when no pull request is open', async () => {
    // First save creates branch + PR.
    await putPage(clientSession);
    // The PR gets closed (rejected) out of band.
    github.openPulls.delete('cms/acme-corp');
    github.branches.set('cms/acme-corp', 'stale-sha');

    await putPage(clientSession);
    // The stale branch was deleted and re-created from HEAD.
    expect(github.branches.get('cms/acme-corp')).toBe('head-sha');
    // A fresh PR was opened.
    expect(github.openPulls.get('cms/acme-corp')?.number).toBe(7);
  });

  it('saves directly (no branch) when review mode is off', async () => {
    await store.update('acme-corp', { requireApproval: false });
    const response = await putPage(clientSession);
    expect(response.status).toBe(200);
    const payload = await data<{ pendingApproval?: boolean }>(response);
    expect(payload.pendingApproval).toBeUndefined();
    expect(github.writes[0]!.branch).toBeUndefined();
    expect(github.openPulls.size).toBe(0);
  });

  it('approval-mode clients read their pending version from the branch', async () => {
    github.branches.set('cms/acme-corp', 'head-sha');
    const response = await repositoryRoutes.handle(
      '/octocat/site/pages/index.html',
      new Request('http://localhost/api/repositories/octocat/site/pages/index.html', {
        headers: { Cookie: `__Host-cms_session=${clientSession}` },
      }),
      ctx,
    );
    expect(response.status).toBe(200);
    const reads = fetchMock.mock.calls.filter(
      ([input]) => String(input).includes('/contents/index.html') && String(input).includes('ref=cms%2Facme-corp'),
    );
    expect(reads).toHaveLength(1);
  });

  it('falls back to the production branch for pages absent from the review branch', async () => {
    github.branches.set('cms/acme-corp', 'head-sha');
    // First read (branch ref) 404s; the fallback (no ref) succeeds.
    let branchRead = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes('/contents/index.html') && url.includes('ref=cms%2Facme-corp')) {
          branchRead = true;
          return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        }
        if (url.includes('/branches/cms%2Facme-corp')) {
          return new Response(JSON.stringify({ commit: { sha: 'head-sha' } }));
        }
        if (url.includes('/contents/index.html')) {
          return new Response(
            JSON.stringify({
              name: 'index.html',
              path: 'index.html',
              sha: 'file-sha',
              size: 4,
              encoding: 'base64',
              content: btoa('<h1>Production</h1>'),
              type: 'file',
            }),
          );
        }
        return new Response(null, { status: 404 });
      }),
    );
    const response = await repositoryRoutes.handle(
      '/octocat/site/pages/index.html',
      new Request('http://localhost/api/repositories/octocat/site/pages/index.html', {
        headers: { Cookie: `__Host-cms_session=${clientSession}` },
      }),
      ctx,
    );
    expect(response.status).toBe(200);
    expect(branchRead).toBe(true);
    const page = await data<{ content: string }>(response);
    expect(page.content).toContain('Production');
  });

  it('toggles review mode through the clients route (admin only)', async () => {
    const off = await clientsRoutes.handle(
      '/acme-corp/approval',
      new Request('http://localhost/api/clients/acme-corp/approval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `__Host-cms_session=${adminSession}` },
        body: JSON.stringify({ requireApproval: false }),
      }),
      ctx,
    );
    expect(off.status).toBe(200);
    expect((await data<{ requireApproval?: boolean }>(off)).requireApproval).toBe(false);

    const invalid = await clientsRoutes.handle(
      '/acme-corp/approval',
      new Request('http://localhost/api/clients/acme-corp/approval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `__Host-cms_session=${adminSession}` },
        body: JSON.stringify({ requireApproval: 'yes' }),
      }),
      ctx,
    );
    expect(invalid.status).toBe(400);

    const forbidden = await clientsRoutes.handle(
      '/acme-corp/approval',
      new Request('http://localhost/api/clients/acme-corp/approval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `__Host-cms_session=${clientSession}` },
        body: JSON.stringify({ requireApproval: true }),
      }),
      ctx,
    );
    expect(forbidden.status).toBe(403);
  });

  it('lists open review pull requests for approval-mode accesses', async () => {
    github.openPulls.set('cms/acme-corp', pr(7, 'cms/acme-corp'));
    github.openPulls.set('feature-x', pr(9, 'feature-x')); // not a review branch

    const response = await reviewRoutes.handle(
      '/',
      new Request('http://localhost/api/review', {
        headers: { Cookie: `__Host-cms_session=${adminSession}` },
      }),
      ctx,
    );
    expect(response.status).toBe(200);
    const pulls = await data<
      Array<{ number: number; clientId: string | null; label: string | null; branch: string }>
    >(response);
    expect(pulls).toHaveLength(1);
    expect(pulls[0]!.number).toBe(7);
    expect(pulls[0]!.clientId).toBe('acme-corp');
    expect(pulls[0]!.label).toBe('ACME Corp');
  });

  it('approves: merges the pull request (production untouched by the client)', async () => {
    github.openPulls.set('cms/acme-corp', pr(7, 'cms/acme-corp'));
    const response = await reviewRoutes.handle(
      '/octocat/site/7/merge',
      new Request('http://localhost/api/review/octocat/site/7/merge', {
        method: 'POST',
        headers: { Cookie: `__Host-cms_session=${adminSession}`, 'X-CSRF-Token': 'test' },
      }),
      ctx,
    );
    expect(response.status).toBe(200);
    expect(github.mergedPulls).toContain(7);
    const payload = await data<{ success: boolean; published: boolean }>(response);
    expect(payload.success).toBe(true);
    expect(payload.published).toBe(false); // no platform connections configured
  });

  it('reports a merge conflict as 409 with a resolve-on-GitHub message', async () => {
    github.openPulls.set('cms/acme-corp', pr(7, 'cms/acme-corp'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith('/pulls/7/update-branch')) {
          return new Response(JSON.stringify({ message: 'conflict' }), { status: 422 });
        }
        if (url.endsWith('/pulls/7/merge')) {
          return new Response(JSON.stringify({ message: 'Pull Request is not mergeable' }), { status: 405 });
        }
        return new Response(null, { status: 404 });
      }),
    );
    const response = await reviewRoutes.handle(
      '/octocat/site/7/merge',
      new Request('http://localhost/api/review/octocat/site/7/merge', {
        method: 'POST',
        headers: { Cookie: `__Host-cms_session=${adminSession}`, 'X-CSRF-Token': 'test' },
      }),
      ctx,
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('review_conflict');
  });

  it('rejects: closes the pull request and resets the review branch', async () => {
    github.openPulls.set('cms/acme-corp', pr(7, 'cms/acme-corp'));
    github.branches.set('cms/acme-corp', 'head-sha');
    const response = await reviewRoutes.handle(
      '/octocat/site/7/close',
      new Request('http://localhost/api/review/octocat/site/7/close', {
        method: 'POST',
        headers: { Cookie: `__Host-cms_session=${adminSession}`, 'X-CSRF-Token': 'test' },
      }),
      ctx,
    );
    expect(response.status).toBe(200);
    expect(github.closedPulls).toContain(7);
    expect(github.branches.has('cms/acme-corp')).toBe(false);
  });

  it('review routes are admin-only', async () => {
    const response = await reviewRoutes.handle(
      '/',
      new Request('http://localhost/api/review', {
        headers: { Cookie: `__Host-cms_session=${clientSession}` },
      }),
      ctx,
    );
    expect(response.status).toBe(403);
  });
});
