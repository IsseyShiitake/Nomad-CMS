/**
 * Unit tests for the DOM-based HTML parser (Milestone 4).
 *
 * Verifies the in-memory editing engine: parse, text edits, image
 * replacement, deletion, insertions above/below, and error handling.
 */
import { describe, expect, it } from 'vitest';
import { DomHtmlParser, type EditableDocument } from './parser';

const parser = new DomHtmlParser();

/** Parses a small fixture and finds an element by tag+position. */
function findFirstId(document: EditableDocument, tagName: string): string {
  const element = document.elements.find((entry) => entry.tagName === tagName);
  if (!element) throw new Error(`No ${tagName} element in fixture`);
  return element.id;
}

const FIXTURE = `
  <!doctype html>
  <html>
    <head><title>Test page</title></head>
    <body>
      <h1>Heading</h1>
      <p>Original text</p>
      <img src="/old.png" alt="Old" />
    </body>
  </html>
`;

describe('DomHtmlParser parse', () => {
  it('collects h1, p and img elements with ids', () => {
    const doc = parser.parse(FIXTURE, 'generic');
    expect(doc.title).toBe('Test page');
    expect(doc.elements.map((e) => e.tagName)).toEqual(['h1', 'p', 'img']);
    expect(doc.elements.every((e) => e.id.startsWith('el--'))).toBe(true);
  });

  it('serializes the current source html', () => {
    const doc = parser.parse(FIXTURE, 'generic');
    expect(parser.serialize(doc)).toBe(doc.sourceHtml);
  });
});

describe('DomHtmlParser source fidelity', () => {
  it('round-trips the original source byte-for-byte with no edits', () => {
    const doc = parser.parse(FIXTURE, 'generic');
    // A no-op save must reproduce the exact bytes the page was loaded with —
    // no doctype loss, no attribute normalization, no injected markers.
    expect(parser.serialize(doc)).toBe(FIXTURE);
  });

  it('changes only the edited element on a text edit', () => {
    const doc = parser.parse(FIXTURE, 'generic');
    const id = findFirstId(doc, 'h1');
    const outcome = parser.apply(doc, { elementId: id, type: 'edit-text', value: 'New heading' });
    expect(outcome.error).toBeNull();
    // Only the h1 text changes; the rest of the source is byte-identical.
    expect(outcome.document?.sourceHtml).toBe(FIXTURE.replace('<h1>Heading</h1>', '<h1>New heading</h1>'));
  });
});

describe('DomHtmlParser edit-text', () => {
  it('replaces the text of a heading', () => {
    const doc = parser.parse(FIXTURE, 'generic');
    const id = findFirstId(doc, 'h1');

    const outcome = parser.apply(doc, { elementId: id, type: 'edit-text', value: 'New heading' });
    expect(outcome.error).toBeNull();

    const element = outcome.document?.elements.find((e) => e.id === id);
    expect(element?.textContent).toBe('New heading');
    // The source is patched surgically, so assert against the new markup.
    expect(outcome.document?.sourceHtml).toContain('>New heading</h1>');
  });

  it('rejects text edits on images', () => {
    const doc = parser.parse(FIXTURE, 'generic');
    const id = findFirstId(doc, 'img');

    const outcome = parser.apply(doc, { elementId: id, type: 'edit-text', value: 'oops' });
    expect(outcome.error).toContain('not available for images');
  });

  it('rejects missing text values', () => {
    const doc = parser.parse(FIXTURE, 'generic');
    const id = findFirstId(doc, 'p');

    const outcome = parser.apply(doc, { elementId: id, type: 'edit-text', value: null });
    expect(outcome.error).toContain('required');
  });
});

describe('DomHtmlParser line breaks', () => {
  it('commits <br> for newlines typed in the editor', () => {
    const doc = parser.parse(FIXTURE, 'generic');
    const id = findFirstId(doc, 'p');

    const outcome = parser.apply(doc, {
      elementId: id,
      type: 'edit-text',
      value: 'First\nSecond',
    });
    expect(outcome.error).toBeNull();

    // The committed markup carries a <br> between the two lines…
    expect(outcome.document?.sourceHtml).toContain('First<br>Second');
    // …and reading it back preserves the break for the textarea.
    const element = outcome.document?.elements.find((e) => e.id === id);
    expect(element?.textContent).toBe('First\nSecond');
  });

  it('reads existing <br> elements back as newlines', () => {
    const html = FIXTURE.replace('<p>Original text</p>', '<p>Alpha<br>Beta</p>');
    const doc = parser.parse(html, 'generic');

    const p = doc.elements.find((e) => e.tagName === 'p');
    expect(p?.textContent).toBe('Alpha\nBeta');
  });

  it('round-trips a line break through save-and-reload', () => {
    const doc = parser.parse(FIXTURE, 'generic');
    const id = findFirstId(doc, 'p');

    const outcome = parser.apply(doc, {
      elementId: id,
      type: 'edit-text',
      value: 'First\nSecond',
    });
    const saved = outcome.document!.sourceHtml;

    // Simulate reload: parse the committed source again.
    const reloaded = parser.parse(saved, 'generic');
    const p = reloaded.elements.find((e) => e.tagName === 'p');
    expect(p?.textContent).toBe('First\nSecond');
  });

  it('leaves newline-free values byte-identical to the old behaviour', () => {
    const doc = parser.parse(FIXTURE, 'generic');
    const id = findFirstId(doc, 'h1');

    const outcome = parser.apply(doc, {
      elementId: id,
      type: 'edit-text',
      value: 'New heading',
    });
    // No \n → no <br>; surgical patch matches the plain-text replacement.
    expect(outcome.document?.sourceHtml).toBe(
      FIXTURE.replace('<h1>Heading</h1>', '<h1>New heading</h1>'),
    );
  });
});

describe('DomHtmlParser replace-image', () => {
  it('replaces the image src', () => {
    const doc = parser.parse(FIXTURE, 'generic');
    const id = findFirstId(doc, 'img');

    const outcome = parser.apply(doc, { elementId: id, type: 'replace-image', value: '/new.png' });
    expect(outcome.error).toBeNull();
    expect(outcome.document?.sourceHtml).toContain('src="/new.png"');
  });

  it('rejects image replacement on text elements', () => {
    const doc = parser.parse(FIXTURE, 'generic');
    const id = findFirstId(doc, 'p');

    const outcome = parser.apply(doc, { elementId: id, type: 'replace-image', value: '/x.png' });
    expect(outcome.error).toContain('only available for images');
  });
});

describe('DomHtmlParser delete', () => {
  it('removes the target element', () => {
    const doc = parser.parse(FIXTURE, 'generic');
    const id = findFirstId(doc, 'p');

    const outcome = parser.apply(doc, { elementId: id, type: 'delete', value: null });
    expect(outcome.error).toBeNull();
    expect(outcome.document?.elements.some((e) => e.id === id)).toBe(false);
    expect(outcome.document?.sourceHtml).not.toContain('Original text');
  });
});

describe('DomHtmlParser insert', () => {
  it('inserts above and below with a chosen tag', () => {
    let doc = parser.parse(FIXTURE, 'generic');
    const h1Id = findFirstId(doc, 'h1');

    const above = parser.apply(doc, {
      elementId: h1Id,
      type: 'insert-above',
      value: null,
      insertTag: 'h2',
    });
    expect(above.error).toBeNull();
    doc = above.document ?? doc;

    const below = parser.apply(doc, {
      elementId: h1Id,
      type: 'insert-below',
      value: null,
      insertTag: 'img',
    });
    expect(below.error).toBeNull();
    doc = below.document ?? doc;

    const source = doc.sourceHtml;
    const h1Index = source.indexOf('>Heading</h1>');
    expect(source.indexOf('>New h2</h2>')).toBeLessThan(h1Index);
    expect(source.indexOf('<img src="/images/placeholder.png"')).toBeGreaterThan(h1Index);
  });

  it('rejects insertions without a tag', () => {
    const doc = parser.parse(FIXTURE, 'generic');
    const id = findFirstId(doc, 'p');

    const outcome = parser.apply(doc, { elementId: id, type: 'insert-above', value: null });
    expect(outcome.error).toContain('An element type is required');
  });
});

describe('DomHtmlParser errors', () => {
  it('reports an unknown element id', () => {
    const doc = parser.parse(FIXTURE, 'generic');
    const outcome = parser.apply(doc, { elementId: 'el--missing', type: 'delete', value: null });
    expect(outcome.error).toBe('Element not found.');
  });
});

describe('DomHtmlParser dollar patterns', () => {
  it('treats $ sequences in edited text as literal characters', () => {
    const doc = parser.parse(FIXTURE, 'generic');
    const id = findFirstId(doc, 'h1');
    const outcome = parser.apply(doc, { elementId: id, type: 'edit-text', value: "Price $' drop" });
    expect(outcome.error).toBeNull();
    // The replacement must be literal: `$'` in a string replacement would be
    // interpreted as a pattern and corrupt the page.
    expect(outcome.document?.sourceHtml).toBe(
      FIXTURE.replace('<h1>Heading</h1>', () => "<h1>Price $' drop</h1>"),
    );
  });
});

describe('DomHtmlParser editable mode', () => {
  const MARKED_FIXTURE = `
    <!doctype html>
    <html>
      <head><title>Marked page</title></head>
      <body>
        <h1>Heading</h1>
        <div data-editable><p>Marked block</p></div>
      </body>
    </html>
  `;

  it('lists only data-editable elements in editable mode', () => {
    const doc = parser.parse(MARKED_FIXTURE, 'editable');
    expect(doc.mode).toBe('editable');
    expect(doc.elements.map((e) => e.tagName)).toEqual(['div']);
  });

  it('lists only beacon tags in generic mode', () => {
    const doc = parser.parse(MARKED_FIXTURE, 'generic');
    expect(doc.mode).toBe('generic');
    expect(doc.elements.map((e) => e.tagName)).toEqual(['h1', 'p']);
  });

  it('marks inserted elements data-editable in editable mode', () => {
    let doc = parser.parse(MARKED_FIXTURE, 'editable');
    const id = findFirstId(doc, 'div');

    const outcome = parser.apply(doc, {
      elementId: id,
      type: 'insert-below',
      value: null,
      insertTag: 'p',
    });

    expect(outcome.error).toBeNull();
    // The inserted paragraph must stay listed in editable mode.
    expect(outcome.document?.elements.map((e) => e.tagName)).toEqual(['div', 'p']);
    expect(outcome.document?.sourceHtml).toContain('<p data-editable="">New p</p>');
  });
});