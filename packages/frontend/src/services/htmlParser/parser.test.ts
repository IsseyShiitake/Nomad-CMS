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

describe('DomHtmlParser sibling adoption', () => {
  const GALLERY_FIXTURE = `<!doctype html>
<html>
  <body>
    <div class="gallery-row">
      <img src="images/a.png" class="tile" width="200" height="200" loading="lazy">
      <img src="images/b.png" class="tile" width="200" height="200" loading="lazy">
    </div>
    <section class="hero">
      <p class="lead">First</p>
      <p class="lead">Second</p>
    </section>
    <p id="solo-unique">Solo paragraph</p>
  </body>
</html>
`;

  it('an inserted image adopts class and sizing from the sibling it joins', () => {
    const doc = parser.parse(GALLERY_FIXTURE, 'generic');
    const firstImg = doc.elements.find((e) => e.tagName === 'img')!;

    const outcome = parser.apply(doc, {
      elementId: firstImg.id,
      type: 'insert-below',
      value: null,
      insertTag: 'img',
    });
    expect(outcome.error).toBeNull();
    // Class and image sizing come from the template sibling; src stays the placeholder.
    expect(outcome.document?.sourceHtml).toContain(
      '<img src="/images/placeholder.png" alt="" class="tile" width="200" height="200" loading="lazy">',
    );
  });

  it('an inserted paragraph adopts the class of its same-tag siblings', () => {
    const doc = parser.parse(GALLERY_FIXTURE, 'generic');
    const firstP = doc.elements.find((e) => e.tagName === 'p')!;

    const outcome = parser.apply(doc, {
      elementId: firstP.id,
      type: 'insert-below',
      value: null,
      insertTag: 'p',
    });
    expect(outcome.error).toBeNull();
    expect(outcome.document?.sourceHtml).toContain('<p class="lead">New p</p>');
  });

  it('inserts stay plain when no same-tag sibling exists', () => {
    const doc = parser.parse(GALLERY_FIXTURE, 'generic');
    const solo = doc.elements.find((e) => e.textContent === 'Solo paragraph')!;

    const outcome = parser.apply(doc, {
      elementId: solo.id,
      type: 'insert-above',
      value: null,
      insertTag: 'p',
    });
    expect(outcome.error).toBeNull();
    expect(outcome.document?.sourceHtml).toContain('<p>New p</p>');
  });

  it('does not adopt a class when the created tag has no sibling of its own tag', () => {
    const doc = parser.parse(GALLERY_FIXTURE, 'generic');
    const firstP = doc.elements.find((e) => e.textContent === 'First')!;

    // Inserting an image below a classed paragraph must NOT give the image
    // the paragraph's class — the template matches the CREATED tag only.
    const outcome = parser.apply(doc, {
      elementId: firstP.id,
      type: 'insert-below',
      value: null,
      insertTag: 'img',
    });
    expect(outcome.error).toBeNull();
    expect(outcome.document?.sourceHtml).toContain(
      '<img src="/images/placeholder.png" alt="">',
    );
  });

  it('adopts from the anchor itself when it is the only element of that tag', () => {
    const single = `<!doctype html>
<html><body>
  <figure class="spotlight">
    <img src="images/one.png" class="big" width="800" height="600">
  </figure>
</body></html>`;
    const doc = parser.parse(single, 'generic');
    const img = doc.elements.find((e) => e.tagName === 'img')!;

    // The audit's motivating case: one picture, add another next to it —
    // the anchor is the template.
    const outcome = parser.apply(doc, {
      elementId: img.id,
      type: 'insert-below',
      value: null,
      insertTag: 'img',
    });
    expect(outcome.error).toBeNull();
    expect(outcome.document?.sourceHtml).toContain(
      '<img src="/images/placeholder.png" alt="" class="big" width="800" height="600">',
    );
  });

  it('never copies identity attributes from the sibling', () => {
    const doc = parser.parse(GALLERY_FIXTURE, 'generic');
    const solo = doc.elements.find((e) => e.textContent === 'Solo paragraph')!;
    const outcome = parser.apply(doc, {
      elementId: solo.id,
      type: 'insert-below',
      value: null,
      insertTag: 'p',
    });
    expect(outcome.error).toBeNull();
    // The created element has no id even though the anchor carries one.
    expect(outcome.document?.sourceHtml.match(/<p[^>]*id=/g)?.length ?? 0).toBe(1);
  });
});

describe('DomHtmlParser shorthand-attribute tolerance', () => {
  const SHORTHAND_FIXTURE = `<!doctype html>
<html lang="en">
  <body>
    <section class="hero">
      <h1 data-editable>Handmade ceramics</h1>
      <p data-editable>Every piece is thrown by hand.</p>
    </section>
  </body>
</html>
`;

  it('edits an element surgically even when the source writes attributes bare', () => {
    const doc = parser.parse(SHORTHAND_FIXTURE, 'editable');
    const h1 = doc.elements.find((e) => e.tagName === 'h1')!;

    const outcome = parser.apply(doc, {
      elementId: h1.id,
      type: 'edit-text',
      value: 'Handmade ceramics, fired weekly',
    });
    expect(outcome.error).toBeNull();
    // The rest of the document is untouched — no whole-file re-serialization:
    // the shorthand paragraph keeps its bare attribute and formatting.
    expect(outcome.document?.sourceHtml).toBe(
      SHORTHAND_FIXTURE.replace(
        '<h1 data-editable>Handmade ceramics</h1>',
        '<h1 data-editable="">Handmade ceramics, fired weekly</h1>',
      ),
    );
  });

  it('inserts beside a shorthand-attr element without reformatting the file', () => {
    const doc = parser.parse(SHORTHAND_FIXTURE, 'editable');
    const h1 = doc.elements.find((e) => e.tagName === 'h1')!;

    const outcome = parser.apply(doc, {
      elementId: h1.id,
      type: 'insert-below',
      value: null,
      insertTag: 'p',
    });
    expect(outcome.error).toBeNull();
    // The anchor keeps the author's bare-attribute form byte-for-byte.
    expect(outcome.document?.sourceHtml).toContain('<h1 data-editable>Handmade ceramics</h1>');
    expect(outcome.document?.sourceHtml).toContain('<p data-editable="">New p</p>');
  });

  it('deleting a shorthand-attr element leaves no stray line', () => {
    const doc = parser.parse(SHORTHAND_FIXTURE, 'editable');
    const h1 = doc.elements.find((e) => e.tagName === 'h1')!;

    const outcome = parser.apply(doc, { elementId: h1.id, type: 'delete', value: null });
    expect(outcome.error).toBeNull();
    expect(outcome.document?.sourceHtml).toBe(
      SHORTHAND_FIXTURE.replace('      <h1 data-editable>Handmade ceramics</h1>\n', ''),
    );
  });
});

describe('DomHtmlParser delete hygiene', () => {
  it('removes the whole line of an element that sat alone on it', () => {
    const source = `<body>\n  <p>Keep</p>\n  <p>Drop me</p>\n  <p>Also keep</p>\n</body>`;
    const doc = parser.parse(source, 'generic');
    const drop = doc.elements.find((e) => e.textContent === 'Drop me')!;

    const outcome = parser.apply(doc, { elementId: drop.id, type: 'delete', value: null });
    expect(outcome.error).toBeNull();
    expect(outcome.document?.sourceHtml).toBe(`<body>\n  <p>Keep</p>\n  <p>Also keep</p>\n</body>`);
  });

  it('removes only the element when it sits inline with other content', () => {
    const source = `<body><p>Before</p> <p>Drop me</p> <p>After</p></body>`;
    const doc = parser.parse(source, 'generic');
    const drop = doc.elements.find((e) => e.textContent === 'Drop me')!;

    const outcome = parser.apply(doc, { elementId: drop.id, type: 'delete', value: null });
    expect(outcome.error).toBeNull();
    expect(outcome.document?.sourceHtml).toBe(
      `<body><p>Before</p>  <p>After</p></body>`,
    );
  });
});

describe('DomHtmlParser fallback serialization', () => {
  it('preserves the trailing newline when falling back to re-serialization', () => {
    // Duplicate markup forces the fallback path (ambiguous needle).
    const source = `<body><p>Same</p><p>Same</p></body>\n`;
    const doc = parser.parse(source, 'generic');
    const first = doc.elements[0]!;

    const outcome = parser.apply(doc, {
      elementId: first.id,
      type: 'edit-text',
      value: 'Changed',
    });
    expect(outcome.error).toBeNull();
    expect(outcome.document?.sourceHtml.endsWith('\n')).toBe(true);
  });
});

describe('DomHtmlParser inline-markup flag', () => {
  it('marks elements containing links or emphasis, and clears the flag after an edit', () => {
    const source = `<body><p>Call <a href="tel:1">123</a> now</p><p>Plain</p></body>`;
    const doc = parser.parse(source, 'generic');
    expect(doc.elements.map((e) => e.containsMarkup)).toEqual([true, false]);

    const linked = doc.elements[0]!;
    const outcome = parser.apply(doc, {
      elementId: linked.id,
      type: 'edit-text',
      value: 'Call 123 now',
    });
    // After the flattening edit the markup is gone, so the re-parse reports false.
    expect(outcome.document?.elements.find((e) => e.id === linked.id)?.containsMarkup).toBe(false);
  });

  it('flags the inline tags the old fixed selector missed (audit 2026-11-15)', () => {
    const source = `<body><p>Year <abbr title="circa">c.</abbr> 1900 <time>12:00</time> <mark>hi</mark> H<sub>2</sub>O <q>quote</q> <cite>X</cite></p></body>`;
    const doc = parser.parse(source, 'generic');
    expect(doc.elements[0]!.containsMarkup).toBe(true);
  });

  it('flags a data-editable-block container with structural children (audit 2026-11-15)', () => {
    // One textarea edit used to silently replace the block's h1/p/img with
    // plain text, with no badge and no confirm — containsMarkup reported
    // false because it only looked for inline tags.
    const source = `<body><section data-editable-block><h1>Title</h1><p>Copy</p><img src="a.png"></section></body>`;
    const doc = parser.parse(source, 'editable');
    const block = doc.elements.find((e) => e.tagName === 'section')!;
    expect(block.containsMarkup).toBe(true);
    expect(block.textContent).toContain('Title');
  });

  it('does not flag br-only children (line breaks survive text edits)', () => {
    const source = `<body><p>Alpha<br>Beta</p></body>`;
    const doc = parser.parse(source, 'generic');
    expect(doc.elements[0]!.containsMarkup).toBe(false);
  });
});

describe('DomHtmlParser occurrence disambiguation (audit 2026-11-15)', () => {
  const DUPLICATES = `<body>\n  <p>Same</p>\n  <p>Same</p>\n  <p>Same</p>\n  <p>Keep me</p>\n</body>`;

  it('edits the TARGET duplicate surgically instead of re-serializing the file', () => {
    const doc = parser.parse(DUPLICATES, 'generic');
    const second = doc.elements[1]!;

    const outcome = parser.apply(doc, {
      elementId: second.id,
      type: 'edit-text',
      value: 'Changed',
    });
    expect(outcome.error).toBeNull();
    // Only the second occurrence changed — the other duplicates and the
    // author's formatting are untouched (no whole-file re-serialization).
    expect(outcome.document?.sourceHtml).toBe(
      `<body>\n  <p>Same</p>\n  <p>Changed</p>\n  <p>Same</p>\n  <p>Keep me</p>\n</body>`,
    );
  });

  it('deletes the TARGET duplicate, not the first occurrence', () => {
    const doc = parser.parse(DUPLICATES, 'generic');
    const third = doc.elements[2]!;

    const outcome = parser.apply(doc, { elementId: third.id, type: 'delete', value: null });
    expect(outcome.error).toBeNull();
    expect(outcome.document?.sourceHtml).toBe(
      `<body>\n  <p>Same</p>\n  <p>Same</p>\n  <p>Keep me</p>\n</body>`,
    );
  });

  it('falls back to re-serialization only when identical elements are formatted differently', () => {
    // Two identical-in-DOM paragraphs, one written bare in the source — the
    // occurrence map is unsound, so the fallback must kick in.
    const mixed = `<body><p data-editable>Same</p><p data-editable="">Same</p></body>\n`;
    const doc = parser.parse(mixed, 'editable');
    const first = doc.elements[0]!;

    const outcome = parser.apply(doc, {
      elementId: first.id,
      type: 'edit-text',
      value: 'Changed',
    });
    expect(outcome.error).toBeNull();
    // No assertion on the exact form: the fallback's output is DOM-normalized.
    expect(outcome.document?.sourceHtml).toContain('Changed');
  });
});

describe('DomHtmlParser line-ending hygiene (audit 2026-11-15)', () => {
  it('a CRLF delete swallows the whole line instead of leaving an empty one', () => {
    const source = `<body>\r\n  <p>Keep</p>\r\n  <p>Drop me</p>\r\n  <p>Also keep</p>\r\n</body>`;
    const doc = parser.parse(source, 'generic');
    const drop = doc.elements.find((e) => e.textContent === 'Drop me')!;

    const outcome = parser.apply(doc, { elementId: drop.id, type: 'delete', value: null });
    expect(outcome.error).toBeNull();
    expect(outcome.document?.sourceHtml).toBe(
      `<body>\r\n  <p>Keep</p>\r\n  <p>Also keep</p>\r\n</body>`,
    );
  });

  it('an insert gets its own line with the anchor indentation (LF files)', () => {
    const source = `<body>\n  <h1>Head</h1>\n  <p>Tail</p>\n</body>`;
    const doc = parser.parse(source, 'generic');
    const h1 = doc.elements.find((e) => e.tagName === 'h1')!;

    const outcome = parser.apply(doc, {
      elementId: h1.id,
      type: 'insert-below',
      value: null,
      insertTag: 'p',
    });
    expect(outcome.error).toBeNull();
    expect(outcome.document?.sourceHtml).toBe(
      `<body>\n  <h1>Head</h1>\n  <p data-editable="">New p</p>\n  <p>Tail</p>\n</body>`
        .replace(' data-editable=""', ''),
    );
  });

  it('an insert in a CRLF file uses CRLF endings and the anchor indentation', () => {
    const source = `<body>\r\n  <h1>Head</h1>\r\n</body>`;
    const doc = parser.parse(source, 'generic');
    const h1 = doc.elements.find((e) => e.tagName === 'h1')!;

    const outcome = parser.apply(doc, {
      elementId: h1.id,
      type: 'insert-below',
      value: null,
      insertTag: 'p',
    });
    expect(outcome.error).toBeNull();
    expect(outcome.document?.sourceHtml).toBe(
      `<body>\r\n  <h1>Head</h1>\r\n  <p>New p</p>\r\n</body>`,
    );
  });
});

describe('DomHtmlParser wrapper-based grid inserts (audit 2026-11-15)', () => {
  const FIGURE_GRID = `<!doctype html>
<html><body>
  <div class="grid">
    <figure class="card"><img src="images/a.png" class="thumb" width="400" height="300" loading="lazy"></figure>
    <figure class="card"><img src="images/b.png" class="thumb" width="400" height="300" loading="lazy"></figure>
  </div>
</body></html>`;

  it('clones the figure cell instead of landing inside the existing one', () => {
    const doc = parser.parse(FIGURE_GRID, 'generic');
    const firstImg = doc.elements.find((e) => e.tagName === 'img')!;

    const outcome = parser.apply(doc, {
      elementId: firstImg.id,
      type: 'insert-below',
      value: null,
      insertTag: 'img',
    });
    expect(outcome.error).toBeNull();
    const html = outcome.document!.sourceHtml;

    // Three figure cells now, each with exactly one image; the new image is
    // a placeholder inside its own cloned figure, carrying the adopted attrs.
    const figures = html.match(/<figure class="card">/g) ?? [];
    expect(figures).toHaveLength(3);
    expect(html.match(/<img src="images\/a\.png"/g)).toHaveLength(1);
    expect(html).toContain(
      '<img src="/images/placeholder.png" alt="" class="thumb" width="400" height="300" loading="lazy">',
    );
    // The clone follows the anchor cell.
    const anchorEnd = html.indexOf('images/a.png');
    const cloneIndex = html.indexOf('/images/placeholder.png');
    expect(cloneIndex).toBeGreaterThan(anchorEnd);
  });

  it('clones an li cell in list-based grids', () => {
    const source = `<!doctype html>
<html><body>
  <ul class="tiles">
    <li><img src="images/one.png"></li>
    <li><img src="images/two.png"></li>
  </ul>
</body></html>`;
    const doc = parser.parse(source, 'generic');
    const firstImg = doc.elements.find((e) => e.tagName === 'img')!;

    const outcome = parser.apply(doc, {
      elementId: firstImg.id,
      type: 'insert-above',
      value: null,
      insertTag: 'img',
    });
    expect(outcome.error).toBeNull();
    const html = outcome.document!.sourceHtml;
    expect((html.match(/<li>/g) ?? []).length).toBe(3);
    // The clone precedes the anchor cell (insert-above).
    expect(html.indexOf('/images/placeholder.png')).toBeLessThan(html.indexOf('images/one.png'));
  });

  it('keeps direct-sibling image rows growing as siblings (no wrapper)', () => {
    // A container holding SEVERAL images is a row, not a unit: adding one
    // more image must stay a sibling insert.
    const source = `<!doctype html>
<html><body>
  <div class="row">
    <img src="images/a.png" class="tile">
    <img src="images/b.png" class="tile">
  </div>
</body></html>`;
    const doc = parser.parse(source, 'generic');
    const firstImg = doc.elements.find((e) => e.tagName === 'img')!;

    const outcome = parser.apply(doc, {
      elementId: firstImg.id,
      type: 'insert-below',
      value: null,
      insertTag: 'img',
    });
    expect(outcome.error).toBeNull();
    const html = outcome.document!.sourceHtml;
    // Still one .row div; three sibling images inside it.
    expect((html.match(/<div class="row">/g) ?? []).length).toBe(1);
    expect(html).toContain('images/a.png');
    expect(html.indexOf('/images/placeholder.png')).toBeGreaterThan(html.indexOf('images/a.png'));
    expect(html.indexOf('/images/placeholder.png')).toBeLessThan(html.indexOf('images/b.png'));
  });

  it('leaves a single (non-repeating) figure alone — the old in-cell insert', () => {
    const source = `<!doctype html>
<html><body>
  <figure class="spotlight"><img src="images/one.png" class="big"></figure>
</body></html>`;
    const doc = parser.parse(source, 'generic');
    const img = doc.elements.find((e) => e.tagName === 'img')!;

    const outcome = parser.apply(doc, {
      elementId: img.id,
      type: 'insert-below',
      value: null,
      insertTag: 'img',
    });
    expect(outcome.error).toBeNull();
    // No same-tag siblings → no unit → the image joins inside the figure.
    expect((outcome.document!.sourceHtml.match(/<figure class="spotlight">/g) ?? []).length).toBe(1);
    expect(outcome.document!.sourceHtml).toContain(
      '<img src="/images/placeholder.png" alt="" class="big">',
    );
  });

  it('removes CMS-marked captions from the cloned cell (no duplicated copy)', () => {
    const source = `<!doctype html>
<html><body>
  <ul class="tiles">
    <li><img src="images/one.png"><p data-editable>Caption one</p></li>
    <li><img src="images/two.png"><p data-editable>Caption two</p></li>
  </ul>
</body></html>`;
    // Beacons mode lists the images (the captions are not the target here).
    const doc = parser.parse(source, 'generic');
    const firstImg = doc.elements.find((e) => e.tagName === 'img')!;

    const outcome = parser.apply(doc, {
      elementId: firstImg.id,
      type: 'insert-below',
      value: null,
      insertTag: 'img',
    });
    expect(outcome.error).toBeNull();
    const html = outcome.document!.sourceHtml;
    expect(html).not.toContain('Caption one</p>\n'); // not duplicated verbatim…
    expect(html).toContain('Caption two'); // …while the anchor cell keeps its copy
    expect((html.match(/<li>/g) ?? []).length).toBe(3);
  });

  it('keeps the fresh image when the anchor cell is CMS-marked (N1 regression)', () => {
    // N1: stripping [data-editable] from the clone BEFORE replacing the
    // cloned image deleted the clone's only image — an empty cell got
    // committed. The strip must run after the replacement and never touch
    // the fresh image (which carries data-editable in editable mode).
    const source = `<!doctype html>
<html><body>
  <ul class="tiles">
    <li data-editable-block><img data-editable src="images/one.png"></li>
    <li data-editable-block><img data-editable src="images/two.png"></li>
  </ul>
</body></html>`;
    const doc = parser.parse(source, 'editable');
    const firstImg = doc.elements.find((e) => e.tagName === 'img')!;

    const outcome = parser.apply(doc, {
      elementId: firstImg.id,
      type: 'insert-below',
      value: null,
      insertTag: 'img',
    });
    expect(outcome.error).toBeNull();
    const html = outcome.document!.sourceHtml;

    // Three marked cells (anchor keeps the bare source form, the clone
    // serializes data-editable-block=""), three images (two originals +
    // the placeholder)…
    expect((html.match(/<li data-editable-block/g) ?? []).length).toBe(3);
    expect((html.match(/<img /g) ?? []).length).toBe(3);
    // …no empty cell was committed…
    expect(html.match(/<li[^>]*><\/li>/g)).toBeNull();
    // …and the placeholder sits inside its own cloned cell, CMS-marked.
    expect(html).toContain('<img src="/images/placeholder.png"');
    const placeholderIdx = html.indexOf('/images/placeholder.png');
    expect(html.slice(0, placeholderIdx).lastIndexOf('<li')).toBeGreaterThan(-1);
  });
});

describe('DomHtmlParser image src clearing (audit 2026-11-15 papercut)', () => {
  it('accepts an empty src (the field can be cleared; the save guard blocks committing it)', () => {
    const doc = parser.parse(FIXTURE, 'generic');
    const id = findFirstId(doc, 'img');

    const outcome = parser.apply(doc, { elementId: id, type: 'replace-image', value: '' });
    expect(outcome.error).toBeNull();
    expect(outcome.document?.sourceHtml).toContain('src=""');
  });
});