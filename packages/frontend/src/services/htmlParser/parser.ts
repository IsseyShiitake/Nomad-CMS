/**
 * DOM-based HTML parser (Milestone 4).
 *
 * Converts raw HTML into an editable document model and back using the
 * browser's DOMParser and DOM APIs only — never regex.
 *
 * Source fidelity: the original HTML string is the source of truth. Edits
 * patch only the targeted element's serialized markup inside that string
 * (surgical replacement), so a no-op save round-trips to the exact bytes the
 * page was loaded with, and a text/src edit changes only that element. The
 * full-document re-serialization path is a fallback used only when the
 * element's markup is malformed or duplicated (so it cannot be located
 * unambiguously in the source). The doctype is preserved in the fallback.
 */

import {
  buildUniqueSelector,
  EDITABLE_SELECTOR,
  GENERIC_SELECTOR,
  type ScanMode,
} from './scanner';

/** A single editable element within a page. */
export interface EditableElement {
  /** Stable identifier for the element within the document. */
  id: string;

  /** Tag name, e.g. "h1", "p", "img". */
  tagName: string;

  /** Current text content, if the element holds text. */
  textContent: string | null;

  /** Source attribute, for images. */
  src: string | null;

  /**
   * True when the element's children include inline markup (links, emphasis,
   * spans). Editing such an element replaces its children with plain text, so
   * the editor warns before the first edit. Recomputed on every parse — after
   * an edit it is false because the markup is already gone.
   */
  containsMarkup: boolean;

  /** CSS selector that uniquely locates the element. */
  selector: string;
}

/** The parsed, editable representation of a page. */
export interface EditableDocument {
  /** The (surgically patched) HTML source of the edited page. */
  sourceHtml: string;

  /** The page title, from the <title> tag. */
  title: string | null;

  /** All editable elements found in the document. */
  elements: EditableElement[];

  /** Scan mode used to select the editable elements. */
  mode: ScanMode;
}

/** Supported element types for insertion. */
export type InsertableTag = 'h1' | 'h2' | 'p' | 'img';

/** Operations the editor can perform on a page. */
export interface EditOperation {
  /** Target element id within the document. */
  elementId: string;

  /** What to change. */
  type: 'edit-text' | 'replace-image' | 'delete' | 'insert-above' | 'insert-below';

  /** New text for edit-text; new src for replace-image. */
  value: string | null;

  /** Tag to insert for insert-above / insert-below. */
  insertTag?: InsertableTag;
}

/** Result of applying an edit operation. */
export interface EditOutcome {
  /** The updated editable document, or null when no page is loaded. */
  document: EditableDocument | null;

  /** Error message when the operation failed, otherwise null. */
  error: string | null;
}

/** Operations the HTML parser exposes to the editor. */
export interface HtmlParser {
  /** Parses raw HTML into an editable document model. */
  parse(html: string, mode: ScanMode): EditableDocument;

  /** Serializes an edited document model back to HTML. */
  serialize(document: EditableDocument): string;

  /** Applies an edit operation in memory and returns the updated document. */
  apply(document: EditableDocument, operation: EditOperation): EditOutcome;
}

/** Placeholder src used for inserted images. Exported for the save guard:
 * a committed placeholder is a guaranteed 404 on the live site. */
export const PLACEHOLDER_SRC = '/images/placeholder.png';

/** Inline markup whose presence marks an element's text as "will be flattened
 * by an edit" — used for the editor's contains-formatting warning. */
const INLINE_MARKUP_SELECTOR = 'a, strong, em, b, i, span, small, code';

/**
 * Attributes an inserted element copies from its template sibling so new
 * content adopts the block's styling parameters. The site's own CSS stays the
 * single source of design truth — the CMS never injects styles. Identity and
 * behavior attributes (id, data-*, aria-*, style, handlers) are never copied.
 */
const ADOPTED_ATTRIBUTES = ['class'];
/** Extra attributes an inserted <img> copies from its template sibling. */
const ADOPTED_IMAGE_ATTRIBUTES = ['width', 'height', 'loading', 'decoding'];

/**
 * The adoption template for a newly created element: the nearest element
 * with the CREATED element's tag among the anchor and its siblings.
 *
 * The anchor itself is considered first (inserting a paragraph next to a
 * paragraph adopts that paragraph's class), then previous siblings, then
 * next ones. A block with no element of the created tag yields null — the
 * insert stays plain instead of borrowing another tag's styling.
 */
function nearestAdoptionTemplate(target: Element, createdTag: string): Element | null {
  if (target.tagName === createdTag) return target;
  for (
    let prev = target.previousElementSibling;
    prev;
    prev = prev.previousElementSibling
  ) {
    if (prev.tagName === createdTag) return prev;
  }
  for (
    let next = target.nextElementSibling;
    next;
    next = next.nextElementSibling
  ) {
    if (next.tagName === createdTag) return next;
  }
  return null;
}

/** Copies the adopted attributes from a template sibling onto a new element. */
function applySiblingTemplate(created: Element, template: Element): void {
  for (const name of ADOPTED_ATTRIBUTES) {
    const value = template.getAttribute(name);
    if (value !== null) created.setAttribute(name, value);
  }
  if (created.tagName === 'IMG') {
    for (const name of ADOPTED_IMAGE_ATTRIBUTES) {
      const value = template.getAttribute(name);
      if (value !== null) created.setAttribute(name, value);
    }
  }
}

/**
 * Attribute-form variants of a serialized element for surgical matching.
 *
 * DOM serialization writes every attribute as `name="value"`; hand-authored
 * HTML often writes empty-valued attributes bare (`<p data-editable>`). When
 * the serialized form is not found verbatim in the source, these variants
 * retry with the empty-valued attributes written bare, so such pages still
 * get surgical patches instead of a whole-document re-serialization.
 *
 * Capped: an element with more than three empty-valued attributes yields no
 * variants (2^3 = 8 combinations maximum) and falls through to the fallback.
 */
const MAX_BARE_ATTRIBUTES = 3;

function attributeFormVariants(serialized: string, emptyValuedNames: string[]): string[] {
  if (emptyValuedNames.length === 0 || emptyValuedNames.length > MAX_BARE_ATTRIBUTES) {
    return [];
  }
  const variants: string[] = [];
  const total = 1 << emptyValuedNames.length;
  for (let mask = 1; mask < total; mask++) {
    let variant = serialized;
    for (let i = 0; i < emptyValuedNames.length; i++) {
      if (mask & (1 << i)) {
        variant = variant.replaceAll(` ${emptyValuedNames[i]}=""`, ` ${emptyValuedNames[i]}`);
      }
    }
    if (variant !== serialized) variants.push(variant);
  }
  // Single-quoted authoring style (`attr=''`): one homogeneous variant.
  let singleQuoted = serialized;
  for (const name of emptyValuedNames) {
    singleQuoted = singleQuoted.replaceAll(` ${name}=""`, ` ${name}=''`);
  }
  if (singleQuoted !== serialized) variants.push(singleQuoted);
  return variants.slice(0, 8);
}

/**
 * Removes `needle` from `sourceHtml`, swallowing the element's whole line
 * (indentation and line breaks) when it sat alone on that line, so deletions
 * never leave whitespace-only lines behind in the committed source.
 */
function removeAloneLineAware(sourceHtml: string, needle: string): string {
  const idx = sourceHtml.indexOf(needle);
  if (idx < 0) return sourceHtml;

  // Indentation directly before the element, if any.
  let start = idx;
  while (start > 0 && (sourceHtml[start - 1] === ' ' || sourceHtml[start - 1] === '\t')) start--;
  const newlineBefore = start > 0 && sourceHtml[start - 1] === '\n';

  // Trailing spaces/tabs after the element, and whether a newline ends the line.
  let scan = idx + needle.length;
  while (scan < sourceHtml.length && (sourceHtml[scan] === ' ' || sourceHtml[scan] === '\t')) scan++;
  const newlineAfter = scan < sourceHtml.length && sourceHtml[scan] === '\n';

  const aloneOnLine = (start === 0 || newlineBefore) && (scan === sourceHtml.length || newlineAfter);
  if (!aloneOnLine) {
    return sourceHtml.slice(0, idx) + sourceHtml.slice(idx + needle.length);
  }
  // Swallow the whole line, keeping a single newline when the file continues.
  const next = newlineAfter ? scan + 1 : scan;
  const keep = newlineBefore ? '\n' : '';
  return sourceHtml.slice(0, newlineBefore ? start - 1 : 0) + keep + sourceHtml.slice(next);
}

/**
 * DOM-based parser implementation.
 *
 * All methods are pure: they read or produce EditableDocument values and
 * never hold persistent state. Element ids are assigned by parse order so
 * they are stable across text/src edits (no focus loss while typing) and
 * collision-free (a 32-bit hash could otherwise route an edit to the wrong
 * element).
 */
export class DomHtmlParser implements HtmlParser {
  /** Parses raw HTML into an editable document model for the given element mode. */
  parse(html: string, mode: ScanMode): EditableDocument {
    const document = new DOMParser().parseFromString(html, 'text/html');
    return toEditableDocument(document, html, mode);
  }

  /** Serializes an edited document model back to HTML. */
  serialize(document: EditableDocument): string {
    return document.sourceHtml;
  }

  /** Applies an edit operation in memory and returns the updated document. */
  apply(document: EditableDocument, operation: EditOperation): EditOutcome {
    const target = document.elements.find((element) => element.id === operation.elementId);
    if (!target) {
      return { document, error: 'Element not found.' };
    }

    const dom = new DOMParser().parseFromString(document.sourceHtml, 'text/html');
    const element = dom.querySelector(target.selector);
    if (!element) {
      return { document, error: 'Element not found.' };
    }

    const oldOuter = element.outerHTML;
    // Empty-valued attributes as the DOM sees them, captured before any edit —
    // the source may write them bare (`data-editable`), which the serialized
    // form (`data-editable=""`) never matches. Used for variant matching.
    const emptyValuedNames = element.getAttributeNames().filter(
      (name) => element.getAttribute(name) === '',
    );
    let replacement = oldOuter;
    let error: string | null = null;
    let createdHtml: string | null = null;
    let insertPosition: 'above' | 'below' | null = null;

    switch (operation.type) {
      case 'edit-text':
        error = editText(element, operation.value);
        if (!error) replacement = element.outerHTML;
        break;
      case 'replace-image':
        error = replaceImage(element, operation.value);
        if (!error) replacement = element.outerHTML;
        break;
      case 'delete':
        element.remove();
        replacement = '';
        break;
      case 'insert-above': {
        const created = insertSibling(element, 'above', operation.insertTag, document.mode);
        if (created) {
          createdHtml = created.outerHTML;
          insertPosition = 'above';
        } else {
          error = 'An element type is required for insertion.';
        }
        break;
      }
      case 'insert-below': {
        const created = insertSibling(element, 'below', operation.insertTag, document.mode);
        if (created) {
          createdHtml = created.outerHTML;
          insertPosition = 'below';
        } else {
          error = 'An element type is required for insertion.';
        }
        break;
      }
    }

    if (error) {
      return { document, error };
    }

    let sourceHtml: string;
    if (replacement === oldOuter && createdHtml === null) {
      sourceHtml = document.sourceHtml;
    } else {
      // Resolve the needle: the serialized form first, then bare-attribute
      // variants for sources written with shorthand attributes.
      let needle = oldOuter;
      let occurrences = countOccurrences(document.sourceHtml, needle);
      if (occurrences !== 1) {
        for (const variant of attributeFormVariants(oldOuter, emptyValuedNames)) {
          const variantOccurrences = countOccurrences(document.sourceHtml, variant);
          if (variantOccurrences === 1) {
            needle = variant;
            occurrences = 1;
            break;
          }
        }
      }
      if (occurrences === 1) {
        if (createdHtml !== null && insertPosition !== null) {
          // Keep the author's source form for the anchor element; only the
          // new element's markup is added.
          const joined =
            insertPosition === 'above' ? `${createdHtml}${needle}` : `${needle}${createdHtml}`;
          sourceHtml = document.sourceHtml.replace(needle, () => joined);
        } else if (operation.type === 'delete') {
          sourceHtml = removeAloneLineAware(document.sourceHtml, needle);
        } else {
          // Surgical patch: replace only this element's markup, leaving the
          // rest of the source byte-for-byte intact (clean git diffs).
          sourceHtml = document.sourceHtml.replace(needle, () => replacement);
        }
      } else {
        // Ambiguous (duplicate markup) or not found (malformed source the
        // DOM normalized). Fall back to a full re-serialization, preserving
        // the doctype and the file's trailing newline.
        sourceHtml = fallbackSerialize(dom);
        if (document.sourceHtml.endsWith('\n') && !sourceHtml.endsWith('\n')) {
          sourceHtml += '\n';
        }
      }
    }

    return { document: toEditableDocument(dom, sourceHtml, document.mode), error: null };
  }
}

/** Edits the text content of a non-image element. */
function editText(element: Element, value: string | null): string | null {
  if (element.tagName.toLowerCase() === 'img') {
    return 'Text editing is not available for images.';
  }
  if (value == null) {
    return 'Text value is required.';
  }

  // Replace all child nodes with the edited content. Newlines typed in the
  // editor become <br> so line breaks survive into the committed HTML; a
  // value without newlines yields a single text node, exactly as before.
  const doc = element.ownerDocument;
  const nodes = value.split('\n').flatMap((segment, index) =>
    index === 0
      ? [doc.createTextNode(segment)]
      : [doc.createElement('br'), doc.createTextNode(segment)],
  );
  element.replaceChildren(...nodes);
  return null;
}

/** Replaces the src of an image element. */
function replaceImage(element: Element, value: string | null): string | null {
  if (element.tagName.toLowerCase() !== 'img') {
    return 'Image replacement is only available for images.';
  }
  if (value == null || value.trim() === '') {
    return 'Image src is required.';
  }
  element.setAttribute('src', value.trim());
  return null;
}

/**
 * Inserts a new element above or below the target. Returns the created
 * element (for surgical serialization), or null if no tag was supplied.
 *
 * The created element adopts the styling parameters of the nearest same-tag
 * sibling (class, and image sizing attributes) so new content fits the block
 * it is added to — the site's CSS remains the design authority.
 *
 * In editable mode the created element is marked data-editable so it stays
 * listed after re-parse (the editable selector only matches marked elements).
 */
function insertSibling(
  target: Element,
  position: 'above' | 'below',
  tag: InsertableTag | undefined,
  mode: ScanMode,
): Element | null {
  if (tag == null) {
    return null;
  }

  const created = target.ownerDocument.createElement(tag);
  if (tag === 'img') {
    created.setAttribute('src', PLACEHOLDER_SRC);
    created.setAttribute('alt', '');
  } else {
    created.textContent = `New ${tag}`;
  }
  if (mode === 'editable') {
    created.setAttribute('data-editable', '');
  }

  const template = nearestAdoptionTemplate(target, tag.toUpperCase());
  if (template) {
    applySiblingTemplate(created, template);
  }

  target.parentElement?.insertBefore(
    created,
    position === 'above' ? target : target.nextSibling,
  );

  return created;
}

/**
 * Serialises an element's visible text with line breaks preserved:
 * `<br>` becomes `\n`, nested inline markup flattens to its text (matching
 * the previous textContent semantics) — so the editor's multi-line
 * textarea shows existing line breaks when a page loads.
 */
function elementToText(element: Element): string {
  let text = '';
  for (const node of element.childNodes) {
    if (node instanceof Text) {
      text += node.data;
    } else if (node instanceof HTMLBRElement) {
      text += '\n';
    } else if (node instanceof Element) {
      text += elementToText(node);
    }
  }
  return text;
}

/**
 * Builds the editable document view of a parsed DOM.
 *
 * The provided `sourceHtml` is kept verbatim as the document's source (it is
 * never re-serialized here), so the saved HTML preserves the author's
 * formatting. Element ids are the unique selector for each element, which is
 * stable across text/src edits (no focus loss while typing) and
 * collision-free.
 */
function toEditableDocument(
  document: Document,
  sourceHtml: string,
  mode: ScanMode,
): EditableDocument {
  // Generic mode targets the beacon tags (h1/h2/p/img); editable mode
  // targets only elements explicitly marked data-editable/-block.
  const elementSelector = mode === 'generic' ? GENERIC_SELECTOR : EDITABLE_SELECTOR;
  const elements: EditableElement[] = Array.from(
    document.querySelectorAll(elementSelector),
  ).map((element) => {
    const isImage = element.tagName.toLowerCase() === 'img';
    const selector = buildUniqueSelector(element);
    return {
      // The id is the unique selector itself (prefixed). It is collision-free
      // (the selector already locates exactly one element) and stable across
      // text/src edits and same-tag-sibling inserts — only structural edits
      // that shift an element's position change its selector, which is correct.
      id: `el--${selector}`,
      tagName: element.tagName.toLowerCase(),
      textContent: isImage ? null : elementToText(element),
      src: isImage ? element.getAttribute('src') : null,
      containsMarkup: element.querySelector(INLINE_MARKUP_SELECTOR) !== null,
      selector,
    };
  });

  return {
    sourceHtml,
    title: document.querySelector('title')?.textContent?.trim() ?? null,
    elements,
    mode,
  };
}

/** Counts non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

/** Full re-serialization fallback that preserves the doctype. */
function fallbackSerialize(document: Document): string {
  const doctype = document.doctype ? `<!doctype ${document.doctype.name}>` : '';
  return `${doctype}${document.documentElement.outerHTML}`;
}
