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
import { CMS_PLACEHOLDER_IMAGE_SRC } from '@cms/shared';

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
   * True when the element has element children that a text edit would
   * replace with plain text — inline markup (links, emphasis, spans) and,
   * since the 2026-11-15 audit, any structural child (a data-editable-block
   * container's headings/images). Editing such an element destroys that
   * markup or structure, so the editor warns before the first edit and
   * asks for confirmation at save time. Recomputed on every parse — after
   * an edit it is false because the children are already gone. `<br>` does
   * not count: line breaks are preserved by text edits (newline → `<br>`).
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
 * a committed placeholder is a guaranteed 404 on the live site. Aliased to
 * the shared constant so the backend save route enforces the exact same
 * string. */
export const PLACEHOLDER_SRC = CMS_PLACEHOLDER_IMAGE_SRC;

/**
 * Whether an element's text edit would flatten or destroy children.
 *
 * Any element child counts EXCEPT `<br>` (text edits regenerate line
 * breaks, so br-only children survive). This covers both the inline case
 * (links, emphasis — the original audit item) and the structural case: a
 * data-editable-block container holding `<h1>/<p>/<img>` children used to
 * report false and let one textarea edit silently destroy the block's
 * contents (audit 2026-11-15, must-fix). It also naturally includes the
 * inline tags the old fixed selector missed (abbr, time, mark, sub, sup,
 * q, cite, …).
 */
function hasFlattenableChildren(element: Element): boolean {
  return Array.from(element.children).some((child) => child.tagName !== 'BR');
}

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

/** The position of the `occurrence`-th (0-based) appearance of `needle`. */
function indexOfOccurrence(source: string, needle: string, occurrence: number): number {
  let index = -1;
  for (let i = 0; i <= occurrence; i += 1) {
    index = source.indexOf(needle, i === 0 ? 0 : index + needle.length);
    if (index < 0) return -1;
  }
  return index;
}

/** Replaces only the `occurrence`-th appearance of `needle` in `source`. */
function replaceOccurrence(
  source: string,
  needle: string,
  occurrence: number,
  replacement: string,
): string {
  const index = indexOfOccurrence(source, needle, occurrence);
  if (index < 0) return source;
  return source.slice(0, index) + replacement + source.slice(index + needle.length);
}

/** The 0-based ordinal of `target` among all elements whose serialized markup
 * equals `serialized`, counting only elements BEFORE it in document order. */
function occurrenceOrdinal(dom: Document, target: Element, serialized: string): number {
  let ordinal = 0;
  for (const element of Array.from(dom.querySelectorAll('*'))) {
    if (element === target) return ordinal;
    if (element.outerHTML === serialized) ordinal += 1;
  }
  return -1;
}

/** How many elements in the document serialize to exactly `serialized`. */
function countIdenticalElements(dom: Document, serialized: string): number {
  let count = 0;
  for (const element of Array.from(dom.querySelectorAll('*'))) {
    if (element.outerHTML === serialized) count += 1;
  }
  return count;
}

/**
 * Removes `needle` (its `occurrence`-th appearance) from `sourceHtml`,
 * swallowing the element's whole line (indentation and line breaks) when it
 * sat alone on that line, so deletions never leave whitespace-only lines
 * behind in the committed source. CRLF files lose their whole `\r\n` line,
 * not just the `\n` (audit 2026-11-15: CRLF deletes used to leave an empty
 * line behind).
 */
function removeAloneLineAware(sourceHtml: string, needle: string, occurrence = 0): string {
  const idx = indexOfOccurrence(sourceHtml, needle, occurrence);
  if (idx < 0) return sourceHtml;

  // Indentation directly before the element, if any.
  let start = idx;
  while (start > 0 && (sourceHtml[start - 1] === ' ' || sourceHtml[start - 1] === '\t')) start--;
  const newlineBefore = start > 0 && sourceHtml[start - 1] === '\n';
  const crBefore = newlineBefore && start > 1 && sourceHtml[start - 2] === '\r';

  // Trailing spaces/tabs after the element, and whether a line ending follows.
  let scan = idx + needle.length;
  while (scan < sourceHtml.length && (sourceHtml[scan] === ' ' || sourceHtml[scan] === '\t')) scan++;
  const crlfAfter = sourceHtml[scan] === '\r' && sourceHtml[scan + 1] === '\n';
  const newlineAfter = crlfAfter || sourceHtml[scan] === '\n';

  const aloneOnLine = (start === 0 || newlineBefore) && (scan === sourceHtml.length || newlineAfter);
  if (!aloneOnLine) {
    return sourceHtml.slice(0, idx) + sourceHtml.slice(idx + needle.length);
  }
  // Swallow the whole line, keeping a single line ending when the file
  // continues — in the file's own ending style.
  const prefixEnd = crBefore ? start - 2 : newlineBefore ? start - 1 : 0;
  const keep = newlineBefore ? (crBefore ? '\r\n' : '\n') : '';
  const suffixStart = crlfAfter ? scan + 2 : newlineAfter ? scan + 1 : scan;
  return sourceHtml.slice(0, prefixEnd) + keep + sourceHtml.slice(suffixStart);
}

/**
 * Line context of a needle occurrence, for indent-preserving inserts:
 * whether the needle sits alone on its line, the indentation before it, and
 * the line ending that follows it (LF or CRLF, defaulting to LF).
 */
function lineContext(
  sourceHtml: string,
  idx: number,
  needleLength: number,
): { aloneOnLine: boolean; indent: string; lineEnding: string } {
  let start = idx;
  while (start > 0 && (sourceHtml[start - 1] === ' ' || sourceHtml[start - 1] === '\t')) start--;
  const indent = sourceHtml.slice(start, idx);
  const newlineBefore = start > 0 && sourceHtml[start - 1] === '\n';

  let scan = idx + needleLength;
  while (scan < sourceHtml.length && (sourceHtml[scan] === ' ' || sourceHtml[scan] === '\t')) scan++;
  const crlfAfter = sourceHtml[scan] === '\r' && sourceHtml[scan + 1] === '\n';
  const lineEnding = crlfAfter ? '\r\n' : sourceHtml[scan] === '\n' ? '\n' : '';
  const aloneOnLine = (start === 0 || newlineBefore) && (scan === sourceHtml.length || lineEnding !== '');
  return { aloneOnLine, indent, lineEnding: lineEnding || '\n' };
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
    // Occurrence data for the default anchor (the target): the switch below
    // mutates the element (text edit, src change, removal), which would
    // break identical-element counting afterwards — so when the needle turns
    // out ambiguous, the DOM-serialization scan must run BEFORE the switch.
    // N3 (perf): the scan serializes every element twice and dominated edit
    // latency on large pages; gate it on the cheap source-side string count
    // and skip it entirely for the common unique-needle case.
    const sourceOccurrences = countOccurrences(document.sourceHtml, oldOuter);
    const baseOrdinal = sourceOccurrences > 1 ? occurrenceOrdinal(dom, element, oldOuter) : -1;
    const baseIdentical = sourceOccurrences > 1 ? countIdenticalElements(dom, oldOuter) : 0;
    // Insert results carry the same data, captured before their own DOM
    // mutation (created element / clone).
    let insertOrdinal = -1;
    let insertIdentical = 0;
    let insertOccurrences = 0;
    let replacement = oldOuter;
    let error: string | null = null;
    let createdHtml: string | null = null;
    let insertPosition: 'above' | 'below' | null = null;
    // The element whose serialized markup the surgical patch splices around:
    // the target itself, or the cloned wrapper unit for unit inserts.
    let anchor: Element = element;

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
        const result = insertSibling(element, 'above', operation.insertTag, document.mode, document.sourceHtml);
        if (result) {
          createdHtml = result.created.outerHTML;
          insertPosition = 'above';
          anchor = result.anchor;
          insertOrdinal = result.anchorOrdinal;
          insertIdentical = result.anchorIdentical;
          insertOccurrences = result.anchorOccurrences;
        } else {
          error = 'An element type is required for insertion.';
        }
        break;
      }
      case 'insert-below': {
        const result = insertSibling(element, 'below', operation.insertTag, document.mode, document.sourceHtml);
        if (result) {
          createdHtml = result.created.outerHTML;
          insertPosition = 'below';
          anchor = result.anchor;
          insertOrdinal = result.anchorOrdinal;
          insertIdentical = result.anchorIdentical;
          insertOccurrences = result.anchorOccurrences;
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
      // Resolve the needle: the anchor's serialized form first, then
      // bare-attribute variants for sources written with shorthand
      // attributes. Unit inserts splice around the wrapper's markup.
      const emptyValuedNames = anchor.getAttributeNames().filter(
        (name) => anchor.getAttribute(name) === '',
      );
      let needle = anchor === element ? oldOuter : anchor.outerHTML;
      let occurrence = 0;
      // Recount for the anchor===element case is unnecessary — the cheap
      // source-side count was taken pre-switch (N3); unit inserts carry
      // theirs from insertSibling.
      let occurrences = anchor === element ? sourceOccurrences : insertOccurrences;
      if (occurrences !== 1) {
        for (const variant of attributeFormVariants(needle, emptyValuedNames)) {
          const variantOccurrences = countOccurrences(document.sourceHtml, variant);
          if (variantOccurrences === 1) {
            needle = variant;
            occurrences = 1;
            break;
          }
        }
      }
      // Ambiguous needle (duplicate identical markup): disambiguate by
      // occurrence. The k-th needle appearance in the source is the k-th
      // identical element in document order — sound whenever every identical
      // element is written the same way (occurrences === identical count).
      // Otherwise (mixed source formatting, or the needle is not found at
      // all because the DOM normalized malformed markup) fall back to a full
      // re-serialization, preserving the doctype and the trailing newline.
      const applyFallback = (): string => {
        let html = fallbackSerialize(dom);
        if (document.sourceHtml.endsWith('\n') && !html.endsWith('\n')) {
          html += '\n';
        }
        return html;
      };
      let fallback = false;
      if (occurrences > 1) {
        const ordinal = anchor === element ? baseOrdinal : insertOrdinal;
        const identical = anchor === element ? baseIdentical : insertIdentical;
        if (ordinal >= 0 && occurrences === identical) {
          occurrence = ordinal;
        } else {
          fallback = true;
        }
      } else if (occurrences === 0) {
        fallback = true;
      }

      if (fallback) {
        sourceHtml = applyFallback();
      } else if (createdHtml !== null && insertPosition !== null) {
        // Keep the author's source form for the anchor element; only the
        // new element's markup is added. When the anchor sits alone on its
        // line, the insert gets its own line with the anchor's indentation
        // (in the file's line-ending style) instead of gluing to the line.
        const idx = indexOfOccurrence(document.sourceHtml, needle, occurrence);
        if (idx < 0) {
          sourceHtml = applyFallback();
        } else {
          const line = lineContext(document.sourceHtml, idx, needle.length);
          const joined = line.aloneOnLine
            ? insertPosition === 'above'
              ? `${createdHtml}${line.lineEnding}${line.indent}${needle}`
              : `${needle}${line.lineEnding}${line.indent}${createdHtml}`
            : insertPosition === 'above'
              ? `${createdHtml}${needle}`
              : `${needle}${createdHtml}`;
          sourceHtml = replaceOccurrence(document.sourceHtml, needle, occurrence, joined);
        }
      } else if (operation.type === 'delete') {
        sourceHtml = removeAloneLineAware(document.sourceHtml, needle, occurrence);
      } else {
        // Surgical patch: replace only this element's markup, leaving the
        // rest of the source byte-for-byte intact (clean git diffs).
        sourceHtml = replaceOccurrence(document.sourceHtml, needle, occurrence, replacement);
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

/** Replaces the src of an image element.
 *
 * An empty string is accepted (the field can be cleared — audit papercut);
 * the editor's save guard then blocks committing the source-less image
 * until a file is uploaded or an existing image is picked. */
function replaceImage(element: Element, value: string | null): string | null {
  if (element.tagName.toLowerCase() !== 'img') {
    return 'Image replacement is only available for images.';
  }
  if (value == null) {
    return 'Image src is required.';
  }
  element.setAttribute('src', value.trim());
  return null;
}

/**
 * The result of a successful insert: the created element (serialized for the
 * surgical patch) and the anchor whose serialized markup the patch splices
 * around — the target itself, or the cloned repeating wrapper unit. The
 * anchor's occurrence-disambiguation numbers are captured BEFORE the DOM is
 * mutated (the created element or clone would otherwise inflate the
 * identical-element count), and only when the anchor needle is ambiguous —
 * the cheap source-side count gates the expensive serialization scan (N3).
 */
interface InsertResult {
  created: Element;
  anchor: Element;
  /** Ordinal of the anchor among elements identical to it, pre-insert (-1 when unambiguous). */
  anchorOrdinal: number;
  /** How many elements were identical to the anchor, pre-insert (0 when unambiguous). */
  anchorIdentical: number;
  /** Source-side occurrence count of the anchor's markup, pre-insert. */
  anchorOccurrences: number;
}

/**
 * The repeating wrapper unit around an image anchor, or null.
 *
 * Qualifies when the anchor img's parent is a "cell" — an element with at
 * least two same-tag siblings (a row/grid of figure, li, div cells) — and
 * that cell contains exactly ONE image (the anchor). Cells holding several
 * images are row containers, not units: adding an image there means adding
 * a direct sibling, which the site CSS already places correctly.
 */
function repeatingWrapperUnit(target: Element): Element | null {
  const wrapper = target.parentElement;
  if (!wrapper || wrapper.tagName === 'BODY' || wrapper.tagName === 'HTML') return null;
  const grand = wrapper.parentElement;
  if (!grand || grand.tagName === 'BODY' || grand.tagName === 'HTML') return null;
  const sameTag = Array.from(grand.children).filter((el) => el.tagName === wrapper.tagName);
  if (sameTag.length < 2) return null;
  const images = wrapper.querySelectorAll('img');
  if (images.length !== 1 || images[0] !== target) return null;
  return wrapper;
}

/**
 * Inserts a new element above or below the target. Returns the created
 * element and the splice anchor, or null if no tag was supplied.
 *
 * The created element adopts the styling parameters of the nearest same-tag
 * sibling (class, and image sizing attributes) so new content fits the block
 * it is added to — the site's CSS remains the design authority.
 *
 * Wrapper-based grids (audit 2026-11-15): when the anchor img sits inside a
 * repeating unit (a figure/li cell among same-tag siblings), the unit is
 * CLONED and the fresh image takes the anchor's place inside the clone —
 * inserting the bare img would land inside the existing cell and break the
 * grid. The cloned image is REPLACED FIRST and only then are CMS-marked
 * elements stripped — excluding the fresh image itself (N1: the anchor img
 * in an editable-mode page may itself carry data-editable; stripping before
 * the replacement removed the clone's only image and committed an EMPTY
 * cell). Marked text siblings (captions) are still removed so the new cell
 * does not duplicate the anchor cell's copy; plain unmarked captions are
 * kept (visible junk the client can delete, never silent breakage).
 *
 * In editable mode the created element is marked data-editable so it stays
 * listed after re-parse (the editable selector only matches marked elements).
 */
function insertSibling(
  target: Element,
  position: 'above' | 'below',
  tag: InsertableTag | undefined,
  mode: ScanMode,
  sourceHtml: string,
): InsertResult | null {
  if (tag == null) {
    return null;
  }

  /**
   * Occurrence data for `anchor`'s markup, captured BEFORE any DOM
   * mutation. The expensive identical-element scan runs only when the cheap
   * source-side count shows the needle is ambiguous (N3).
   */
  function anchorOccurrenceData(anchor: Element): {
    ordinal: number;
    identical: number;
    occurrences: number;
  } {
    const occurrences = countOccurrences(sourceHtml, anchor.outerHTML);
    if (occurrences <= 1) {
      return { ordinal: -1, identical: 0, occurrences };
    }
    return {
      ordinal: occurrenceOrdinal(target.ownerDocument, anchor, anchor.outerHTML),
      identical: countIdenticalElements(target.ownerDocument, anchor.outerHTML),
      occurrences,
    };
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

  // Wrapper-unit cloning for image inserts into repeating cells.
  if (tag === 'img' && target.tagName === 'IMG') {
    const unit = repeatingWrapperUnit(target);
    if (unit) {
      // The anchor image is the adoption template for its own replacement.
      applySiblingTemplate(created, target);
      const anchorData = anchorOccurrenceData(unit);
      const clone = unit.cloneNode(true) as Element;
      // Replace the cloned image FIRST (N1): the anchor img may itself carry
      // data-editable in an editable-mode page, and stripping before the
      // replacement deleted the clone's only image — committing an empty
      // cell.
      const unitImages: Element[] = Array.from(unit.querySelectorAll('img'));
      const cloneImages: Element[] = Array.from(clone.querySelectorAll('img'));
      const cloneImage = cloneImages[unitImages.indexOf(target)];
      if (cloneImage) {
        cloneImage.replaceWith(created);
      }
      // THEN strip CMS-managed text from the clone — never the fresh image
      // (created carries data-editable in editable mode) nor any element
      // that contains it.
      clone.querySelectorAll('[data-editable], [data-editable-block]').forEach((el) => {
        if (el === created || el.contains(created)) return;
        el.remove();
      });
      unit.parentElement?.insertBefore(clone, position === 'above' ? unit : unit.nextSibling);
      // The clone IS the added markup: its serialization carries the fresh
      // image inside a copy of the unit, so the surgical patch splices the
      // whole cell, not a bare img.
      return {
        created: clone,
        anchor: unit,
        anchorOrdinal: anchorData.ordinal,
        anchorIdentical: anchorData.identical,
        anchorOccurrences: anchorData.occurrences,
      };
    }
  }

  // Occurrence data BEFORE the created element joins the DOM.
  const anchorData = anchorOccurrenceData(target);
  const template = nearestAdoptionTemplate(target, tag.toUpperCase());
  if (template) {
    applySiblingTemplate(created, template);
  }

  target.parentElement?.insertBefore(
    created,
    position === 'above' ? target : target.nextSibling,
  );

  return {
    created,
    anchor: target,
    anchorOrdinal: anchorData.ordinal,
    anchorIdentical: anchorData.identical,
    anchorOccurrences: anchorData.occurrences,
  };
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
      containsMarkup: hasFlattenableChildren(element),
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
