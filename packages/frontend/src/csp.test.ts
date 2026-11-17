/**
 * Tests for the page CSP source of truth.
 *
 * Browsers ignore `frame-ancestors` when delivered via `<meta>` and log a
 * console error on every page load, so the meta policy must not carry it.
 * Framing protection lives in the HTTP `_headers` copy instead (built by
 * vite.config.ts), which is the only delivery form that enforces it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function metaCsp(): string {
  const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
  const match = /<meta[^>]+http-equiv="Content-Security-Policy"[^>]+content="([^"]+)"/.exec(html);
  if (!match) throw new Error('no CSP meta tag in index.html');
  return match[1]!;
}

describe('index.html CSP meta', () => {
  it("does not carry frame-ancestors (ignored in meta delivery)", () => {
    expect(metaCsp()).not.toContain('frame-ancestors');
  });

  it('keeps the remaining policy intact', () => {
    const csp = metaCsp();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("base-uri 'self'");
  });
});
