/**
 * Tests for the GitHub client's file-read behavior.
 *
 * Invariant: GitHub's contents API answers HTTP 200 with an EMPTY content
 * string for files between 1 MB and 100 MB (only the raw media type carries
 * the bytes at that size). readFile must detect that and fall back to the
 * raw host — serving the empty string would let the editor load a blank
 * page and a subsequent save would commit the blank over the real file.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { GitHubClient } from './client';

describe('GitHubClient.readFile large-file fallback', () => {
  let fetchSpy: Mock;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to the raw host when the contents API returns empty content for a big file', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: 'big.html',
            path: 'big.html',
            sha: 'sha-1',
            size: 5_000_000,
            encoding: 'none',
            content: '',
            type: 'file',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      // Raw fallback: real bytes.
      .mockResolvedValueOnce(
        new Response('<html><body><h1>Big</h1></body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      );

    const client = new GitHubClient('ghp_test');
    const result = await client.readFile('octocat', 'site', 'big.html');

    expect(result.content).toBe('<html><body><h1>Big</h1></body></html>');
    expect(result.sha).toBe('sha-1');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const rawUrl = String(fetchSpy.mock.calls[1]![0]);
    expect(rawUrl).toContain('https://raw.githubusercontent.com/octocat/site/HEAD/big.html');
    // The raw fetch must carry the token (private repositories).
    const rawHeaders = fetchSpy.mock.calls[1]![1]!.headers as Record<string, string>;
    expect(rawHeaders.Authorization).toBe('Bearer ghp_test');
  });

  it('uses the base64 content directly for normally-sized files', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          name: 'index.html',
          path: 'index.html',
          sha: 'sha-2',
          size: 512,
          encoding: 'base64',
          content: Buffer.from('<h1>Hi</h1>').toString('base64'),
          type: 'file',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = new GitHubClient('ghp_test');
    const result = await client.readFile('octocat', 'site', 'index.html');

    expect(result.content).toBe('<h1>Hi</h1>');
    expect(result.sha).toBe('sha-2');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('GitHubClient.hasHtmlFiles', () => {
  let fetchSpy: Mock;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const treeResponse = (tree: Array<{ path: string; type: string }>, truncated = false) =>
    new Response(JSON.stringify({ tree, truncated }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  it('reports true when the tree contains an HTML blob (any casing/extension)', async () => {
    fetchSpy.mockResolvedValueOnce(
      treeResponse([
        { path: 'README.md', type: 'blob' },
        { path: 'site/index.HTM', type: 'blob' },
      ]),
    );
    const client = new GitHubClient('ghp_test');
    await expect(client.hasHtmlFiles('octocat', 'site')).resolves.toBe(true);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain(
      '/repos/octocat/site/git/trees/HEAD?recursive=1',
    );
  });

  it('reports false when the tree has no HTML files', async () => {
    fetchSpy.mockResolvedValueOnce(
      treeResponse([
        { path: 'README.md', type: 'blob' },
        { path: 'src', type: 'tree' },
      ]),
    );
    const client = new GitHubClient('ghp_test');
    await expect(client.hasHtmlFiles('octocat', 'site')).resolves.toBe(false);
  });

  it('still reports true on a truncated tree without hits (never hides on a technicality)', async () => {
    fetchSpy.mockResolvedValueOnce(treeResponse([{ path: 'src', type: 'tree' }], true));
    const client = new GitHubClient('ghp_test');
    await expect(client.hasHtmlFiles('octocat', 'site')).resolves.toBe(true);
  });

  it('reports false for an empty repository (HTTP 409)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('{"message":"Git Repository is empty."}', { status: 409 }),
    );
    const client = new GitHubClient('ghp_test');
    await expect(client.hasHtmlFiles('octocat', 'site')).resolves.toBe(false);
  });

  it('propagates other upstream errors for the caller to mark unknown', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{"message":"Not Found"}', { status: 404 }));
    const client = new GitHubClient('ghp_test');
    await expect(client.hasHtmlFiles('octocat', 'site')).rejects.toThrow();
  });
});
