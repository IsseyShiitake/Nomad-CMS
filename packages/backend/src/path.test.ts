/**
 * Tests for the shared path validators.
 *
 * These are the server-side guards against path traversal and arbitrary file
 * overwrites. They MUST reject `..`, hidden segments, absolute paths, and
 * disallowed extensions while accepting legitimate nested HTML and image
 * paths.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_BYTES,
  basename,
  encodePath,
  safeAssetPath,
  sanitizeImageFileName,
  safePagePath,
} from '@cms/shared';

describe('safePagePath', () => {
  it('accepts top-level and nested html files', () => {
    expect(safePagePath('index.html')).toBe('index.html');
    expect(safePagePath('src/pages/index.html')).toBe('src/pages/index.html');
    expect(safePagePath('a/b/c.htm')).toBe('a/b/c.htm');
  });

  it('rejects traversal, hidden, absolute, and non-html paths', () => {
    expect(safePagePath('../.github/workflows/ci.yml')).toBeNull();
    expect(safePagePath('.env')).toBeNull();
    expect(safePagePath('foo/.hidden/x.html')).toBeNull();
    expect(safePagePath('../secret.html')).toBeNull();
    expect(safePagePath('page.txt')).toBeNull();
    expect(safePagePath('/abs.html')).toBeNull();
    expect(safePagePath('')).toBeNull();
  });
});

describe('sanitizeImageFileName', () => {
  it('strips path components and keeps the basename', () => {
    expect(sanitizeImageFileName('../evil.png')).toBe('evil.png');
    expect(sanitizeImageFileName('a/b/c.jpg')).toBe('c.jpg');
    expect(sanitizeImageFileName('normal.webp')).toBe('normal.webp');
    expect(sanitizeImageFileName('photo.JPEG')).toBe('photo.JPEG');
  });

  it('rejects dotfiles, svg (XSS), and unknown extensions', () => {
    expect(sanitizeImageFileName('.hidden.png')).toBeNull();
    expect(sanitizeImageFileName('evil.svg')).toBeNull();
    expect(sanitizeImageFileName('evil.html')).toBeNull();
    expect(sanitizeImageFileName('noext')).toBeNull();
    expect(sanitizeImageFileName('')).toBeNull();
  });
});

describe('basename', () => {
  it('strips windows and posix separators', () => {
    expect(basename('a/b/c.png')).toBe('c.png');
    expect(basename('a\\b\\c.png')).toBe('c.png');
    expect(basename('c.png')).toBe('c.png');
  });
});

describe('MAX_IMAGE_BYTES', () => {
  it('is 10 MiB', () => {
    expect(MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('safeAssetPath', () => {
  it('accepts nested asset paths with static-file extensions', () => {
    expect(safeAssetPath('style.css')).toBe('style.css');
    expect(safeAssetPath('assets/img/hero.png')).toBe('assets/img/hero.png');
    expect(safeAssetPath('fonts/inter.woff2')).toBe('fonts/inter.woff2');
  });

  it('rejects traversal, hidden, and absolute paths', () => {
    expect(safeAssetPath('../secret.png')).toBeNull();
    expect(safeAssetPath('.env')).toBeNull();
    expect(safeAssetPath('a/.hidden/x.css')).toBeNull();
    expect(safeAssetPath('/abs.png')).toBeNull();
    // No extension restriction by design (any non-hidden file is a legal
    // preview asset) — html included.
    expect(safeAssetPath('index.html')).toBe('index.html');
    expect(safeAssetPath('')).toBeNull();
  });
});

describe('encodePath', () => {
  it('encodes each segment without touching separators', () => {
    expect(encodePath('a b/c&d.png')).toBe('a%20b/c%26d.png');
    expect(encodePath('plain.css')).toBe('plain.css');
  });
});
