/**
 * Tests for the sandboxed preview document builder.
 *
 * Audit 2026-11-15: root-absolute asset URLs (/css/style.css) used to
 * resolve against the CMS origin root — the SPA fallback served index.html
 * instead of the asset, breaking the preview for such sites. buildSrcDoc now
 * rewrites root-absolute URLs onto the injected proxy base (only when the
 * preview injects the base; a page declaring its own <base> is untouched).
 */
import { describe, expect, it } from 'vitest';
import { buildSrcDoc } from './index';

const PROXY_BASE = 'https://cms.example.com/api/repositories/octocat/site/raw/';

describe('buildSrcDoc root-absolute URL rewrite (audit 2026-11-15)', () => {
  it('rewrites root-absolute src/href/poster onto the proxy base', () => {
    const html = `<html><head><link rel="stylesheet" href="/css/style.css"></head>` +
      `<body><img src="/images/hero.png"><video poster="/images/poster.jpg"></video></body></html>`;
    const doc = buildSrcDoc(html, PROXY_BASE, null);

    expect(doc).toContain(`href="${PROXY_BASE}css/style.css"`);
    expect(doc).toContain(`src="${PROXY_BASE}images/hero.png"`);
    expect(doc).toContain(`poster="${PROXY_BASE}images/poster.jpg"`);
    // No bare root-absolute asset URLs remain (script/link/img).
    expect(doc).not.toContain('href="/css/');
    expect(doc).not.toContain('src="/images/');
  });

  it('rewrites the URL tokens of a srcset', () => {
    const html = `<html><body><img src="/a.png" srcset="/img/a.png 480w, /img/a@2x.png 960w"></body></html>`;
    const doc = buildSrcDoc(html, PROXY_BASE, null);

    expect(doc).toContain(`srcset="${PROXY_BASE}img/a.png 480w, ${PROXY_BASE}img/a@2x.png 960w"`);
  });

  it('leaves a data-URI srcset byte-identical (no comma-split corruption)', () => {
    // A data URI's base64 payload sits after a comma; a naive split/rejoin
    // inserted a space after that comma and broke the URI (audit follow-up).
    const srcset = 'data:image/gif;base64,R0lGODlhAQABAAAAADs= 1x';
    const html = `<html><body><img src="/a.png" srcset="${srcset}"></body></html>`;
    const doc = buildSrcDoc(html, PROXY_BASE, null);

    expect(doc).toContain(`srcset="${srcset}"`);
  });

  it('rewrites only root-absolute candidates in a mixed srcset, data URIs untouched', () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
    const html =
      `<html><body><img src="/a.png" srcset="/img/a.png 480w, ${dataUri}, /img/a@2x.png 2x"></body></html>`;
    const doc = buildSrcDoc(html, PROXY_BASE, null);

    expect(doc).toContain(`srcset="${PROXY_BASE}img/a.png 480w, ${dataUri}, ${PROXY_BASE}img/a@2x.png 2x"`);
  });

  it('leaves relative, protocol-relative, and data URLs untouched', () => {
    const html = `<html><head><link rel="stylesheet" href="css/style.css"></head>` +
      `<body><img src="images/local.png"><img src="//cdn.example.com/x.png"><img src="data:image/gif;base64,R0lGODlh"></body></html>`;
    const doc = buildSrcDoc(html, PROXY_BASE, null);

    expect(doc).toContain('href="css/style.css"'); // resolved by <base>
    expect(doc).toContain('src="images/local.png"');
    expect(doc).toContain('src="//cdn.example.com/x.png"');
    expect(doc).toContain('src="data:image/gif;base64,R0lGODlh"');
  });

  it('does not rewrite when the page declares its own <base> (foreign origin)', () => {
    const html = `<html><head><base href="https://cdn.example.com/site/"><link rel="stylesheet" href="/css/style.css"></head><body></body></html>`;
    const doc = buildSrcDoc(html, PROXY_BASE, null);

    expect(doc).toContain('href="/css/style.css"');
    expect(doc).not.toContain(PROXY_BASE);
  });

  it('still neutralizes anchors (rewriting must not resurrect links)', () => {
    const html = `<html><body><a href="/about.html">About</a></body></html>`;
    const doc = buildSrcDoc(html, PROXY_BASE, null);

    // The anchor keeps no href (the injected <base> is the only href left).
    expect(doc).toContain('<a>About</a>');
    expect(doc).not.toContain('<a href');
    expect(doc).not.toContain('/about.html');
  });
});
