/**
 * HTML scanner.
 *
 * Milestone 3 implementation. Given raw HTML and a scan mode, the
 * scanner detects elements of interest using the browser's
 * DOMParser and DOM APIs only — never regex (project policy).
 *
 * Scan modes:
 *   - "generic"  — detects h1, h2, p and img elements.
 *   - "editable" — detects only elements carrying a
 *                  data-editable or data-editable-block attribute.
 *
 * The scanner is intentionally read-only: it locates elements and
 * builds previews. Editing and serialization belong to the HTML
 * parser (Milestone 4), not this module.
 *
 * RETAINED DELIBERATELY (2026-09-26 review): the DomHtmlScanner class has
 * had no production caller since the scanner PANEL was deleted (the editor
 * uses the parser + buildUniqueSelector directly); only this module's tests
 * exercise it. It is kept as the canonical, tested definition of the scan
 * modes the editor's detection semantics derive from — delete it only
 * together with that contract.
 */

/** Scan mode controlling which elements are detected. */
export type ScanMode = 'generic' | 'editable';

/** A single element detected by the scanner. */
export interface DetectedElement {
  /** Tag name, e.g. "h1", "p", "img". */
  tagName: string;

  /** Human-readable preview of the element's content. */
  preview: string;

  /** CSS selector that uniquely locates the element in the document. */
  selector: string;
}

/** The result of scanning a single HTML document. */
export interface ScannedDocument {
  /** Page title from the <title> tag, if present. */
  title: string | null;

  /** Detected elements, in document order. */
  elements: DetectedElement[];
}

/** Operations the HTML scanner exposes to the UI. */
export interface HtmlScanner {
  /** Scans raw HTML and returns the elements matching the mode. */
  scan(html: string, mode: ScanMode): ScannedDocument;
}

/** Element selectors detected in generic mode. */
export const GENERIC_SELECTOR = 'h1, h2, p, img';

/** Element selectors detected in editable mode. */
export const EDITABLE_SELECTOR = '[data-editable], [data-editable-block]';

/** Maximum preview length before text is truncated. */
const PREVIEW_MAX_LENGTH = 120;

/**
 * DOM-based scanner.
 *
 * Parses HTML with the standards-compliant DOMParser and walks the
 * resulting document with DOM APIs. No regex is ever used to
 * inspect or modify HTML.
 */
export class DomHtmlScanner implements HtmlScanner {
  scan(html: string, mode: ScanMode): ScannedDocument {
    const document = new DOMParser().parseFromString(html, 'text/html');
    const selector = mode === 'generic' ? GENERIC_SELECTOR : EDITABLE_SELECTOR;

    const elements = Array.from(document.querySelectorAll(selector)).map(describeElement);

    return {
      title: extractTitle(document),
      elements,
    };
  }
}

/** Reads the trimmed <title> of the document, if present. */
function extractTitle(document: Document): string | null {
  const title = document.querySelector('title')?.textContent?.trim();
  return title ? title : null;
}

/** Builds the preview text and unique selector for an element. */
function describeElement(element: Element): DetectedElement {
  return {
    tagName: element.tagName.toLowerCase(),
    preview: elementPreview(element),
    selector: buildUniqueSelector(element),
  };
}

/**
 * Preview content for an element.
 *
 * Images preview their src attribute; text elements preview their
 * trimmed text content, truncated for readability.
 */
function elementPreview(element: Element): string {
  if (element.tagName.toLowerCase() === 'img') {
    const src = element.getAttribute('src');
    return src ? src.trim() : '(no src)';
  }

  // Collapse runs of whitespace (newlines, tabs, indentation) into single
  // spaces so multi-line text content produces a readable one-line preview.
  // This operates on the plain-text preview only; the source HTML is never
  // modified.
  const text = element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  if (!text) {
    return '(empty)';
  }

  return text.length > PREVIEW_MAX_LENGTH
    ? `${text.slice(0, PREVIEW_MAX_LENGTH)}…`
    : text;
}

/**
 * Builds a CSS selector that uniquely resolves to the element.
 *
 * Walks from the element to the root of the document, recording
 * each tag. When a tag appears multiple times among its siblings,
 * the position is qualified with :nth-of-type so every step of the
 * path is unambiguous. Because the full path is qualified,
 * querySelector on the result matches exactly one element.
 *
 * Exported for reuse by the HTML parser (Milestone 4), which needs
 * the same unique selectors to locate elements when serializing.
 */
export function buildUniqueSelector(element: Element): string {
  const parts: string[] = [];
  let node: Element | null = element;

  while (node !== null) {
    const current: Element = node;
    const tagName: string = current.tagName.toLowerCase();
    const parent: HTMLElement | null = current.parentElement;

    if (!parent) {
      parts.unshift(tagName);
      break;
    }

    const sameTagSiblings: Element[] = Array.from(parent.children).filter(
      (sibling: Element) => sibling.tagName === current.tagName,
    );

    const position: number = sameTagSiblings.indexOf(current) + 1;
    parts.unshift(
      sameTagSiblings.length > 1 ? `${tagName}:nth-of-type(${position})` : tagName,
    );

    node = parent;
  }

  return parts.join(' > ');
}
