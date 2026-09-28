import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { encodePath } from '@cms/shared';
import type { PageSummary, Repository } from '@cms/shared';
import { getPage, listPages } from '@/api';
import { config } from '@/config';
import { useI18n } from '@/i18n';
import { buildSrcDoc } from '@/services/preview';
import './RepoTile.css';

/** How long to wait for the thumbnail iframe before trying the next URL. */
const FALLBACK_TIMEOUT_MS = 9000;

/** Host suffixes the backend preview proxy serves (same allowlist). */
const PROXIED_SUFFIXES = ['.github.io', '.pages.dev', '.vercel.app'];

/** Virtual desktop viewport the site is rendered at, then scaled to the tile. */
const CAPTURE_WIDTH_PX = 1200;
/**
 * Normal desktop screen height (a 1200×800 viewport). Taller boxes do NOT
 * inflate the virtual viewport — the site must render as on a real screen,
 * so the capture ends and the box fades below it instead of stretching
 * the page over an unnatural viewport.
 */
const CAPTURE_MAX_HEIGHT_PX = 800;

/** Number of pastel fallback gradients (`.repo-thumb__fallback--0..5`). */
const FALLBACK_COUNT = 6;

/** Deterministic pastel gradient index derived from the repository name. */
function fallbackIndex(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % FALLBACK_COUNT;
}

/**
 * Deterministic tier-2 page choice from the repo's discovered HTML files:
 * `index.html` at the root, else any root-level page, else the first
 * page in the list. Root pages matter most — the miniature should read
 * like the site's front door, whatever its filename.
 */
function pickPreviewPage(paths: Array<PageSummary['path']>): string | null {
  if (paths.length === 0) return null;
  const rootPages = paths.filter((path) => !path.includes('/'));
  return (
    rootPages.find((path) => path.toLowerCase() === 'index.html') ??
    rootPages.find((path) => path.toLowerCase().endsWith('.html')) ??
    paths[0]
  );
}

/**
 * Ordered list of candidate preview URLs for a repository.
 *
 * 1. the owner-configured homepage (GitHub API `homepage`) when it is a
 *    real web URL and not the github.com repo page (never frameable),
 * 2. the GitHub Pages convention — user/org sites (`owner.github.io`
 *    repos) serve at the root, project sites at `/<repo>/`.
 */
export function thumbnailCandidates(repo: Repository): string[] {
  const out: string[] = [];
  const home = repo.homepage?.trim();
  if (home) {
    try {
      const url = new URL(home.startsWith('http') ? home : `https://${home}`);
      if (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        !url.hostname.endsWith('github.com')
      ) {
        out.push(url.toString());
      }
    } catch {
      /* malformed homepage — fall through to the convention */
    }
  }
  const isUserSite = repo.name.toLowerCase() === `${repo.owner.toLowerCase()}.github.io`;
  const convention = isUserSite
    ? `https://${repo.owner}.github.io/`
    : `https://${repo.owner}.github.io/${repo.name}/`;
  if (!out.includes(convention)) out.push(convention);
  return out;
}

/**
 * Wraps a candidate in the same-origin preview proxy when the Worker can
 * serve it (the three static-hosting suffixes the proxy allowlists);
 * other candidates — e.g. custom homepage domains — are framed directly.
 *
 * The proxy URL is prefixed with config.apiBaseUrl when set: a
 * split-domain deployment's static host does not serve /api/*, and its SPA
 * fallback would answer 200 text/html here — the tile would "screenshot"
 * the CMS's own login page instead of the site.
 */
function previewSrc(candidate: string): string {
  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol === 'https:' &&
      PROXIED_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix))
    ) {
      const base = config.apiBaseUrl ? config.apiBaseUrl.replace(/\/$/, '') : '';
      return `${base}/api/preview?url=${encodeURIComponent(candidate)}`;
    }
  } catch {
    /* malformed candidate: frame it as-is and let the load path fail */
  }
  return candidate;
}

/**
 * Miniature capture tile for a repository's website.
 *
 * Three tiers, first reachable one wins:
 * 1. live site — a scaled, NON-INTERACTIVE iframe snapshot (scriptless
 *    sandbox → the site's static HTML+CSS paints, no external JS runs)
 *    of the first reachable candidate URL (owner homepage / the GitHub
 *    Pages convention, via the same-origin preview proxy);
 * 2. repo render — when no candidate URL answers, the repo's own HTML
 *    is fetched and rendered through the editor preview's sanitizer
 *    (buildSrcDoc + the same-origin raw-asset proxy), so unpublished
 *    repos still show a real miniature, private ones included;
 * 3. monogram — a pastel fallback panel with the repo initial.
 *
 * When a candidate fails or stalls, the next one is tried; tier-2 fetch
 * failures go straight to the monogram (no retry). The capture is
 * cover-fit: the iframe's virtual desktop viewport is sized from the
 * tile box (ResizeObserver) so the miniature always fills the tile
 * edge-to-edge, aligned to the page header. Platform live URLs
 * (Cloudflare Pages / Vercel), when provided, are tried first.
 */
export function RepoTile(props: {
  repo: Repository;
  onSelect?: () => void;
  size?: 'tile' | 'banner' | 'card';
  className?: string;
  /** Platform live URLs (Cloudflare/Vercel) to try before the conventions. */
  liveUrls?: string[];
}): JSX.Element {
  const { repo, onSelect, size = 'tile', className, liveUrls = [] } = props;
  const { m } = useI18n();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  // Tier 2: the sanitized repo HTML (null until the repo-render attempt
  // starts) and whether that attempt has been made — state, not a ref,
  // so the timeout effect re-arms a fresh 9s window for the attempt.
  const [repoDoc, setRepoDoc] = useState<string | null>(null);
  const [repoTried, setRepoTried] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  const candidates = [...liveUrls, ...thumbnailCandidates(repo)];
  const [candidateIdx, setCandidateIdx] = useState(0);
  const thumbnailUrl = candidates[Math.min(candidateIdx, candidates.length - 1)];

  // Perf: only mount the capture iframe when the tile is (nearly) on
  // screen — a grid of tiles otherwise loads N full external websites at
  // once. jsdom (tests) has no IntersectionObserver: fall back to eager.
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(typeof IntersectionObserver === 'undefined');

  // Cover-fit scale: the tile's box drives the iframe's rendered viewport
  // (width/CAPTURE_WIDTH_PX) and its scaled height, so the capture covers
  // the tile exactly — no letterboxing, no fixed magic numbers per size.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !frameRef.current) return;
    const el = frameRef.current;
    const apply = (w: number, h: number) => {
      if (w <= 0) return;
      const scale = w / CAPTURE_WIDTH_PX;
      const renderedHeight = Math.min(Math.round(h / scale), CAPTURE_MAX_HEIGHT_PX);
      el.style.setProperty('--thumb-scale', String(scale));
      el.style.setProperty('--thumb-viewport-height', `${renderedHeight}px`);
    };
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) apply(box.width, box.height);
    });
    observer.observe(el);
    const rect = el.getBoundingClientRect();
    apply(rect.width, rect.height);
    return () => observer.disconnect();
    // The frame element is replaced (ref churn) when the capture mounts or
    // fails; re-running then is exactly right for measuring its box.
  }, [failed, inView]);

  /** Tier transitions: next candidate URL, then one repo-render attempt,
      then the monogram. */
  const advanceCandidate = useCallback(() => {
    setFrameSrc(null);
    if (candidateIdx + 1 < candidates.length) setCandidateIdx(candidateIdx + 1);
    else if (!repoTried) setRepoTried(true);
    else setFailed(true);
  }, [candidateIdx, candidates.length, repoTried]);

  // Preflight the candidate before framing it: the preview proxy (or the
  // direct site) answers 404 for unpublished sites, and without this check
  // the iframe would happily "screenshot" the error page.
  useEffect(() => {
    if (!inView || failed || frameSrc || repoTried) return;
    let cancelled = false;
    const src = previewSrc(thumbnailUrl);
    // credentials: 'include' matters for the split-domain case (the preview
    // route is session-gated); same-origin requests carry cookies anyway.
    fetch(src, { cache: 'force-cache', credentials: 'include' }).then(
      (response) => {
        if (cancelled) return;
        if (response.ok) setFrameSrc(src);
        else advanceCandidate();
      },
      () => {
        if (!cancelled) advanceCandidate();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [inView, failed, frameSrc, repoTried, thumbnailUrl, advanceCandidate]);

  // Tier 2: fetch the repo's own HTML and sanitize it into an srcDoc
  // (same pipeline as the editor preview). One attempt — any error, or a
  // repo with no HTML at all, lands on the monogram (tier 3).
  useEffect(() => {
    if (!inView || failed || !repoTried || repoDoc) return;
    let cancelled = false;
    const load = async () => {
      try {
        const pages = await listPages(repo.owner, repo.name);
        const path = pickPreviewPage(pages.map((page) => page.path));
        if (path === null) throw new Error('no html pages in repository');
        const page = await getPage(repo.owner, repo.name, path);
        if (cancelled) return;
        // Same-origin asset base as the editor preview: relative CSS /
        // images / fonts load through the raw proxy with correct MIME.
        // config.apiBaseUrl keeps split-domain deployments working (the
        // empty default means same-origin).
        const dir = path.split('/').slice(0, -1).join('/');
        const origin = config.apiBaseUrl ? config.apiBaseUrl.replace(/\/$/, '') : window.location.origin;
        const baseHref = `${origin}/api/repositories/${repo.owner}/${repo.name}/raw/${dir ? `${encodePath(dir)}/` : ''}`;
        setRepoDoc(buildSrcDoc(page.content, baseHref, null));
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [inView, failed, repoTried, repoDoc, repo.owner, repo.name]);

  // Give each attempt ~9s (URL candidates and the repo render alike) to
  // produce a loaded frame; then advance, and once every tier is spent
  // fall back to the monogram. Not armed while out of view; also bounds
  // the preflight and tier-2 fetches above.
  useEffect(() => {
    if (!inView || loaded || failed) return;
    timerRef.current = window.setTimeout(advanceCandidate, FALLBACK_TIMEOUT_MS);
    return () => window.clearTimeout(timerRef.current);
  }, [inView, loaded, failed, repoTried, advanceCandidate]);

  useEffect(() => {
    if (inView || !frameRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(frameRef.current);
    return () => observer.disconnect();
  }, [inView]);

  const handleLoad = () => {
    window.clearTimeout(timerRef.current);
    setLoaded(true);
  };

  const handleError = () => {
    window.clearTimeout(timerRef.current);
    advanceCandidate();
  };

  const rootClass = `repo-thumb repo-thumb--${size}${className ? ` ${className}` : ''}`;

  const content = (
    <>
      {(!loaded || failed) && (
        <div
          className={`repo-thumb__fallback repo-thumb__fallback--${fallbackIndex(repo.name)}`}
          aria-hidden="true"
        >
          <span className="repo-thumb__initial">{repo.name.charAt(0).toUpperCase()}</span>
        </div>
      )}
      {!failed && (
        <div className="repo-thumb__frame" ref={frameRef}>
          {inView && (frameSrc || repoDoc) && (
            <iframe
              key={frameSrc ?? 'repo-doc'}
              className={`repo-thumb__iframe${loaded ? ' repo-thumb__iframe--loaded' : ''}`}
              src={frameSrc ?? undefined}
              srcDoc={frameSrc ? undefined : (repoDoc ?? undefined)}
              // Static miniature: the site's own scripts never run — pure
              // HTML+CSS paint, no third-party JS on our page, no per-frame
              // work behind the glass surfaces. The tier-2 srcDoc is
              // sanitized by the same buildSrcDoc pipeline as the editor
              // preview, so it is equally script-free.
              sandbox="allow-same-origin"
              tabIndex={-1}
              aria-hidden="true"
              loading="lazy"
              title={`${repo.name} preview`}
              onLoad={handleLoad}
              onError={handleError}
            />
          )}
        </div>
      )}
      <span className="repo-thumb__label">
        <span className="repo-thumb__name">{repo.name}</span>
        {size === 'tile' && (
          <span className="repo-thumb__chip">
            {repo.isPrivate ? m.repositories.private : m.repositories.public}
          </span>
        )}
      </span>
    </>
  );

  if (onSelect) {
    return (
      <button type="button" className={rootClass} onClick={onSelect}>
        {content}
      </button>
    );
  }

  return <div className={rootClass}>{content}</div>;
}
