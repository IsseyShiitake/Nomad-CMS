/**
 * Tests for the embedded-asset serving used by the single-file build.
 *
 * Covers: known files serve with their content type, ETag, cache policy,
 * and the `_headers` "/*" security headers; If-None-Match revalidation
 * answers 304; unmatched paths fall back to the embedded index.html
 * (SPA, 200 — including missing asset files); non-GET/HEAD methods get a
 * bodiless 405 that still carries the security headers; HEAD serves
 * headers only.
 */
import { describe, expect, it } from 'vitest';
import { serveEmbedded, type EmbeddedAssets } from './embedded';

function fixture(): EmbeddedAssets {
  return {
    files: {
      '/index.html': {
        body: btoa('<html>root</html>'),
        contentType: 'text/html',
        etag: '"etag-index"',
        cacheControl: 'public, max-age=0, must-revalidate',
      },
      '/assets/index-Ab12Cd.js': {
        body: btoa('console.log(1)'),
        contentType: 'text/javascript',
        etag: '"etag-js"',
        cacheControl: 'public, max-age=31536000, immutable',
      },
    },
    securityHeaders: {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'",
    },
  };
}

function get(pathname: string, assets: EmbeddedAssets, headers?: HeadersInit): Response {
  return serveEmbedded(new Request(`https://cms.example${pathname}`, { headers }), assets);
}

describe('serveEmbedded', () => {
  it('serves a known HTML file with its policy and the security headers', async () => {
    const response = get('/', fixture());
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(response.headers.get('ETag')).toBe('"etag-index"');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'self'");
    expect(await response.text()).toBe('<html>root</html>');
  });

  it('serves hashed assets as immutable with the right MIME type', async () => {
    const response = get('/assets/index-Ab12Cd.js', fixture());
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/javascript');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(await response.text()).toBe('console.log(1)');
  });

  it('answers 304 for a matching If-None-Match, without a body', async () => {
    const response = get('/assets/index-Ab12Cd.js', fixture(), {
      'If-None-Match': '"etag-js"',
    });
    expect(response.status).toBe(304);
    expect(response.headers.get('ETag')).toBe('"etag-js"');
    expect(await response.text()).toBe('');
  });

  it('falls back to index.html for unmatched SPA routes and missing assets', async () => {
    const assets = fixture();
    for (const pathname of ['/settings/connections', '/assets/definitely-missing.js']) {
      const response = get(pathname, assets);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/html');
      expect(response.headers.get('ETag')).toBe('"etag-index"');
      expect(await response.text()).toBe('<html>root</html>');
    }
  });

  it('rejects non-GET/HEAD methods with a bodiless 405 that keeps the security headers', async () => {
    const response = serveEmbedded(
      new Request('https://cms.example/', { method: 'POST' }),
      fixture(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Type')).toBeNull();
    expect(await response.text()).toBe('');
  });

  it('serves HEAD requests with headers only', async () => {
    const response = serveEmbedded(
      new Request('https://cms.example/', { method: 'HEAD' }),
      fixture(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html');
    expect(response.body).toBeNull();
  });
});
