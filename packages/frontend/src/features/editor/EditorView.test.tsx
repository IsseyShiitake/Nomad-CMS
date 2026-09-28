/**
 * Unit tests for the preview click hit-test.
 *
 * The click listener runs inside the preview iframe's document, so the
 * resolver receives the raw event target and walks up to the nearest
 * stamped editable element via `closest`. These tests use real parsed
 * documents (real `closest`/`getAttribute`) to verify the walk.
 */
import { describe, expect, it } from 'vitest';
import { resolveClickedElementId } from './EditorView';

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('resolveClickedElementId', () => {
  it('returns the stamped id when the target is inside a stamped element', () => {
    const doc = parse(
      '<html><body><div data-cms-element-id="el--x"><span>hi</span></div></body></html>',
    );
    expect(resolveClickedElementId(doc.querySelector('span'))).toBe('el--x');
  });

  it('returns the stamped id when the target is the stamped element itself', () => {
    const doc = parse(
      '<html><body><p data-cms-element-id="el--html > body > p">text</p></body></html>',
    );
    expect(resolveClickedElementId(doc.querySelector('p'))).toBe('el--html > body > p');
  });

  it('returns null when the target has no stamped ancestor', () => {
    const doc = parse('<html><body><footer>foot</footer></body></html>');
    expect(resolveClickedElementId(doc.querySelector('footer'))).toBeNull();
  });

  it('returns null for a null target', () => {
    expect(resolveClickedElementId(null)).toBeNull();
  });

  it('returns null for a non-Element target (e.g. the document itself)', () => {
    const doc = parse('<html><body><span>hi</span></body></html>');
    expect(resolveClickedElementId(doc)).toBeNull();
  });
});
