/**
 * Unit tests for the DOM-based HTML scanner.
 *
 * The scanner is the core of Milestone 3. These tests verify
 * scanning accuracy for both modes against realistic HTML,
 * including edge cases such as duplicate tags and attributes.
 */
import { describe, expect, it } from 'vitest';
import { DomHtmlScanner } from './scanner';

/** Scanner instance shared across tests. */
const scanner = new DomHtmlScanner();

describe('DomHtmlScanner generic mode', () => {
  it('detects h1, h2, p and img in document order', () => {
    const html = `
      <!doctype html>
      <html>
        <head><title>Example</title></head>
        <body>
          <h1>Welcome</h1>
          <h2>Section</h2>
          <p>Some text.</p>
          <img src="/logo.png" alt="Logo" />
          <h1>Second heading</h1>
        </body>
      </html>
    `;

    const result = scanner.scan(html, 'generic');

    expect(result.title).toBe('Example');
    expect(result.elements).toHaveLength(5);

    expect(result.elements[0]).toMatchObject({ tagName: 'h1', preview: 'Welcome' });
    expect(result.elements[1]).toMatchObject({ tagName: 'h2', preview: 'Section' });
    expect(result.elements[2]).toMatchObject({ tagName: 'p', preview: 'Some text.' });
    expect(result.elements[3]).toMatchObject({ tagName: 'img', preview: '/logo.png' });
    expect(result.elements[4]).toMatchObject({ tagName: 'h1', preview: 'Second heading' });
  });

  it('returns an empty result for a document with no matching elements', () => {
    const result = scanner.scan('<div>nothing here</div>', 'generic');
    expect(result.title).toBeNull();
    expect(result.elements).toHaveLength(0);
  });

  it('truncates long text previews', () => {
    const longText = 'x'.repeat(300);
    const result = scanner.scan(`<p>${longText}</p>`, 'generic');
    expect(result.elements[0].preview.endsWith('…')).toBe(true);
    expect(result.elements[0].preview.length).toBeLessThan(longText.length);
  });

  it('labels an image without a src attribute', () => {
    const result = scanner.scan('<img alt="missing" />', 'generic');
    expect(result.elements[0].preview).toBe('(no src)');
  });

  it('labels empty text elements', () => {
    const result = scanner.scan('<p></p>', 'generic');
    expect(result.elements[0].preview).toBe('(empty)');
  });
});

describe('DomHtmlScanner editable mode', () => {
  it('detects only elements with data-editable or data-editable-block', () => {
    const html = `
      <h1>Not editable</h1>
      <p data-editable>Editable paragraph</p>
      <div data-editable-block>
        <h2>Block heading</h2>
        <p>Inside the block</p>
      </div>
    `;

    const result = scanner.scan(html, 'editable');

    expect(result.elements).toHaveLength(2);
    expect(result.elements[0]).toMatchObject({
      tagName: 'p',
      preview: 'Editable paragraph',
    });
    expect(result.elements[1]).toMatchObject({
      tagName: 'div',
      preview: 'Block heading Inside the block',
    });
  });

  it('ignores regular h1, h2, p and img elements without the attribute', () => {
    const html = `
      <h1>Plain heading</h1>
      <img src="/plain.png" />
      <h2 data-editable>Editable heading</h2>
    `;

    const result = scanner.scan(html, 'editable');

    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toMatchObject({ tagName: 'h2' });
  });
});

describe('DomHtmlScanner unique selectors', () => {
  it('qualifies repeated tags with nth-of-type', () => {
    const html = `
      <main>
        <h1>First</h1>
        <p>A</p>
        <p>B</p>
      </main>
    `;

    const result = scanner.scan(html, 'generic');
    const paragraphs = result.elements.filter((element) => element.tagName === 'p');

    // The selector is a full, unambiguous path from the document root.
    expect(paragraphs[0].selector).toBe('html > body > main > p:nth-of-type(1)');
    expect(paragraphs[1].selector).toBe('html > body > main > p:nth-of-type(2)');
  });

  it('returns a selector that resolves to exactly one element', () => {
    const html = `
      <div>
        <section>
          <h2>One</h2>
        </section>
        <section>
          <h2>Two</h2>
        </section>
      </div>
    `;

    const result = scanner.scan(html, 'generic');
    // Re-parse the same fixture so the selectors can be verified against a
    // document that actually contains the scanned elements.
    const parsed = new DOMParser().parseFromString(html, 'text/html');

    for (const element of result.elements) {
      const matches = parsed.querySelectorAll(element.selector);
      expect(matches).toHaveLength(1);
    }
  });

  it('builds a simple selector for an element inside the body', () => {
    const result = scanner.scan('<h1>Hi</h1>', 'generic');
    // Elements outside the body get a document-root-qualifying selector;
    // the body path exists in every parsed document.
    expect(result.elements[0].selector.endsWith('h1')).toBe(true);
  });
});