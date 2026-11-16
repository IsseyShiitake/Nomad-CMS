/**
 * Editor state module.
 *
 * Manages the state of the page editor: the current document,
 * unsaved changes, and in-memory editing operations (Milestone 4).
 *
 * Milestone 5 adds persistence: `save` serializes the current
 * document, uploads any pending images, updates their src, and
 * commits the modified HTML back to the repository through the
 * backend proxy. Merge conflicts and upload failures are surfaced
 * through `saveError`.
 */

import { getPage, savePage } from '@/api';
import { ApiClientError } from '@/api/client';
import type { ImageAsset } from '@cms/shared';
import type { ImageManager } from '@/services/images';

/**
 * Backend error codes mapped to machine codes (describeSaveError
 * localizes them). Everything else surfaces the backend/parser message —
 * without this set, French users would see raw English API messages.
 * The two placeholder_* codes are detected locally by the save guard AND
 * enforced server-side by the save route (same codes, same localized copy);
 * image_src_missing is detected locally only.
 */
const MAPPED_SAVE_CODES = new Set([
  'merge_conflict',
  'rate_limited',
  'file_too_large',
  'invalid_content',
  'invalid_path',
  'repo_too_large',
  'placeholder_image',
  'placeholder_text',
  'image_src_missing',
]);

/**
 * Parser-invariant messages mapped to machine codes so the UI localizes
 * them (audit 2026-11-15 papercut: they used to pass through as raw
 * English to French users). Unknown messages still pass through verbatim.
 */
const PARSER_ERROR_CODES: Record<string, string> = {
  'Element not found.': 'element_not_found',
  'Text value is required.': 'text_value_required',
  'Image src is required.': 'image_src_required',
  'Text editing is not available for images.': 'text_edit_not_for_images',
  'Image replacement is only available for images.': 'replace_image_only_images',
  'An element type is required for insertion.': 'insert_tag_required',
  'No page loaded.': 'no_page_loaded',
};

/** One flatten-risk record: an element whose edit will replace markup or
 * structure with plain text when saved. tagName + the pre-edit text preview
 * feed the save-time confirmation dialog. */
interface FlattenRisk {
  tagName: string;
  preview: string;
}

import {
  PLACEHOLDER_SRC,
  type EditOperation,
  type EditOutcome,
  type EditableDocument,
  type HtmlParser,
  type ScanMode,
} from '@/services/htmlParser';

/** The current state of the editor for a single page. */
export interface EditorState {
  /** The repository-relative path of the page being edited. */
  pagePath: string;

  /** The parsed editable document. */
  document: EditableDocument | null;

  /** Whether the document has unsaved changes. */
  isDirty: boolean;

  /** Whether a save is currently in progress. */
  isSaving: boolean;

  /** The last save error, if any. */
  saveError: string | null;

  /** The repository's existing image assets, for the editor's picker. */
  images: ImageAsset[];

  /**
   * Review mode: the pull-request URL of the pending change after a
   * successful save awaiting approval (null on direct saves / after reload).
   */
  pendingApprovalUrl: string | null;

  /** Whether an undo step is available. */
  canUndo: boolean;
}

/** Actions the editor can perform on its state. */
export interface EditorActions {
  /** Loads a page into the editor and returns the parsed document. */
  loadPage: (pagePath: string, mode: ScanMode) => Promise<EditableDocument>;

  /**
   * Re-parses the current document with a different element mode.
   * Only valid while the document is clean (no unsaved edits): it
   * re-parses `sourceHtml`, which equals the last loaded/saved
   * content, and clears the undo history.
   */
  setMode: (mode: ScanMode) => void;

  /** Updates the document and marks the editor dirty. */
  updateDocument: (document: EditableDocument) => void;

  /** Applies an in-memory edit operation. */
  applyEdit: (operation: EditOperation) => EditOutcome;

  /**
   * Registers a local image file to be uploaded for an element on
   * the next save. The element's src is not changed until the
   * upload succeeds during save.
   */
  registerImageUpload: (elementId: string, file: File) => void;

  /** Refreshes the repository's image listing for the editor's picker. */
  loadImages: () => Promise<void>;

  /** Saves the current document: uploads images, then commits HTML. */
  save: () => Promise<void>;

  /**
   * Reverts the last applied edit operation. Each successful
   * `applyEdit` records a snapshot of the previous document, so
   * undo restores the document to the state before the edit.
   */
  undo: () => void;
}

/** The combined editor state and actions. */
export interface EditorController extends EditorState, EditorActions {}

/** Dependencies required to construct an editor controller. */
export interface EditorControllerDependencies {
  /** DOM-based parser used for parse / serialize / edits. */
  parser: HtmlParser;

  /** Repository owner. */
  owner: string;

  /** Repository name. */
  repo: string;

  /** Image manager used to upload pending images on save. */
  imageManager: ImageManager;
}

/**
 * Editor controller with persistence.
 *
 * Loads page HTML through the backend proxy, parses it into an
 * editable document, applies edit operations in memory, and on
 * `save` uploads pending images and commits the modified HTML.
 */
export class InMemoryEditorController implements EditorController {
  private readonly parser: HtmlParser;
  private readonly owner: string;
  private readonly repo: string;
  private readonly imageManager: ImageManager;

  /** SHA of the last loaded/saved file, used for optimistic concurrency. */
  private fileSha: string | null = null;

  /** elementId → local file awaiting upload on the next save. */
  private readonly pendingImageUploads = new Map<string, File>();

  /**
   * elementId → committed image path for images already uploaded in the
   * current save attempt. Kept across retries so a failed save (e.g. a
   * merge conflict on the HTML commit) does not re-upload the same files
   * and orphan duplicate blobs in the repo.
   */
  private readonly committedImagePaths = new Map<string, string>();

  /**
   * Flatten risks recorded at EDIT time: an element whose pre-edit state had
   * flattenable children (inline markup or structural content) and whose
   * text was changed. Keyed by the id AT EDIT TIME and carrying its own
   * tagName/preview, the record survives the id shifts that later
   * insert/delete operations cause — the old save-time id matching missed
   * exactly those elements (audit 2026-11-15).
   */
  private flattenRisks = new Map<string, FlattenRisk>();

  /** The repository's existing image assets, for the editor's picker. */
  images: ImageAsset[] = [];

  /**
   * Undo snapshots. Each carries the risk-map era alongside the document so
   * undoing an edit also un-records the flatten risk that edit introduced.
   */
  private readonly undoStack: Array<{ document: EditableDocument; risks: Map<string, FlattenRisk> }> = [];

  pagePath = '';
  document: EditableDocument | null = null;
  isDirty = false;
  isSaving = false;
  saveError: string | null = null;
  pendingApprovalUrl: string | null = null;
  canUndo = false;

  constructor(dependencies: EditorControllerDependencies) {
    this.parser = dependencies.parser;
    this.owner = dependencies.owner;
    this.repo = dependencies.repo;
    this.imageManager = dependencies.imageManager;
  }

  /** Loads a page and returns the freshly parsed document. */
  async loadPage(pagePath: string, mode: ScanMode): Promise<EditableDocument> {
    const page = await getPage(this.owner, this.repo, pagePath);
    const document = this.parser.parse(page.content, mode);

    this.pagePath = page.path;
    this.document = document;
    this.fileSha = page.sha;
    this.isDirty = false;
    this.saveError = null;
    this.pendingApprovalUrl = null;
    this.pendingImageUploads.clear();
    this.committedImagePaths.clear();
    this.flattenRisks.clear();
    this.undoStack.length = 0;
    this.canUndo = false;

    return document;
  }

  /** Refreshes the repository's image listing for the editor's picker.
   * Failures leave the previous listing (or empty) — the picker is
   * additive and must not break the editor. */
  async loadImages(): Promise<void> {
    try {
      this.images = await this.imageManager.listImages(this.owner, this.repo);
    } catch {
      this.images = [];
    }
  }

  /** Re-parses the current clean document with a different element mode. */
  setMode(mode: ScanMode): void {
    if (!this.document) return;
    // The caller only invokes this while the document is clean (the UI
    // disables mode switching with unsaved changes), so sourceHtml equals
    // the last loaded/saved content and no edit is lost by re-parsing.
    this.document = this.parser.parse(this.document.sourceHtml, mode);
    this.undoStack.length = 0;
    this.canUndo = false;
  }

  /** Replaces the current document in memory. */
  updateDocument(document: EditableDocument): void {
    this.document = document;
    this.isDirty = true;
  }

  /** Applies an edit operation in memory. */
  applyEdit(operation: EditOperation): EditOutcome {
    if (!this.document) {
      return { document: this.document, error: 'No page loaded.' };
    }

    const previous = this.document;
    // The pre-edit target: its containsMarkup state decides whether this
    // edit records a flatten risk (edit-text only).
    const target = previous.elements.find((element) => element.id === operation.elementId);
    const outcome = this.parser.apply(this.document, operation);

    if (outcome.error != null) {
      const code = PARSER_ERROR_CODES[outcome.error] ?? outcome.error;
      this.document = outcome.document;
      this.saveError = code;
      return { document: outcome.document, error: code };
    }

    // Successful edits mark the document dirty, push an undo snapshot (with
    // the risk map as it was BEFORE the edit) and — for text edits to
    // elements that carried flattenable children — record the flatten risk.
    this.document = outcome.document;
    this.isDirty = true;
    const risksBefore = new Map(this.flattenRisks);
    if (operation.type === 'delete') {
      // A deleted element's flatten risk must not keep firing the save
      // confirmation for content that no longer exists (N4, false positive).
      this.flattenRisks.delete(operation.elementId);
    } else if (operation.type === 'edit-text' && target?.containsMarkup) {
      this.flattenRisks.set(operation.elementId, {
        tagName: target.tagName,
        preview: (target.textContent ?? '').slice(0, 60),
      });
    }
    this.undoStack.push({ document: previous, risks: risksBefore });
    this.canUndo = true;
    this.saveError = null;
    return { document: outcome.document, error: null };
  }

  /** Reverts the last edit operation, if any. Blocked while a save is in
   * flight: the save commits its earlier document snapshot, so an undo
   * landing mid-save would be overwritten by that snapshot on success. */
  undo(): void {
    if (this.isSaving) return;
    const previous = this.undoStack.pop();
    if (!previous) {
      this.canUndo = false;
      return;
    }

    this.document = previous.document;
    this.flattenRisks = previous.risks;
    this.isDirty = true;
    this.saveError = null;

    // Image uploads queued for an undone edit remain pending: the
    // user may re-apply the edit, and uploads are only committed on
    // save. Undoing a document change does not discard queued files.
    this.canUndo = this.undoStack.length > 0;
  }

  /**
   * Elements whose inline markup or structure the current unsaved edits
   * would flatten: recorded at EDIT time for every text edit whose target
   * carried flattenable children. Each entry names the element and previews
   * its pre-edit text so the editor can ask for an explicit confirmation
   * before saving. Edit-time recording survives the id shifts that later
   * insert/delete operations cause.
   */
  flattenedMarkupEdits(): Array<{ tagName: string; preview: string }> {
    return Array.from(this.flattenRisks.values());
  }

  /** Registers a local file to be uploaded for an element on save. */
  registerImageUpload(elementId: string, file: File): void {
    this.pendingImageUploads.set(elementId, file);
    this.isDirty = true;
    this.saveError = null;
  }

  /**
   * Saves the current document.
   *
   * Two-phase commit:
   *   1. Upload any pending images, collecting elementId → new src.
   *   2. Apply the new srcs to the document, serialize, and commit
   *      the HTML with the message "CMS: Updated {path}".
   *
   * On success the file SHA is refreshed and pending uploads are
   * cleared. On failure (upload or merge conflict) the error is
   * surfaced and the document is left untouched so the user can
   * retry.
   */
  /**
   * Save blockers: inserted content still in its template state. A committed
   * placeholder image is a guaranteed 404 on the live site; committed
   * "New p" text is junk copy a visitor would see; a source-less image (the
   * src field can now be cleared) resolves to the page URL. All must be
   * resolved (image uploaded/picked, text edited, or element deleted) before
   * committing.
   */
  private findSaveBlocker(): string | null {
    if (!this.document) return null;
    for (const element of this.document.elements) {
      if (
        element.tagName === 'img' &&
        element.src === PLACEHOLDER_SRC &&
        !this.pendingImageUploads.has(element.id) &&
        !this.committedImagePaths.has(element.id)
      ) {
        return 'placeholder_image';
      }
      if (element.tagName === 'img' && element.src === '') {
        return 'image_src_missing';
      }
      if (element.textContent === `New ${element.tagName}`) {
        return 'placeholder_text';
      }
    }
    return null;
  }

  async save(): Promise<void> {
    // Re-entrancy guard: a second save while one is in flight would race
    // the same base sha into GitHub (a false merge conflict for the user
    // whose commit actually landed) and double-fire auto-publish.
    if (this.isSaving) return;
    if (!this.document) {
      this.saveError = 'No page loaded.';
      return;
    }

    // Template-state guard: never commit placeholder content.
    const blocker = this.findSaveBlocker();
    if (blocker) {
      this.saveError = blocker;
      return;
    }

    this.isSaving = true;
    this.saveError = null;

    try {
      // Phase 1 — upload pending images. Reuse paths already committed in a
      // prior (failed) attempt so retries are idempotent and do not create
      // duplicate image blobs in the repository.
      const srcUpdates = new Map<string, string>();
      for (const [elementId, file] of this.pendingImageUploads) {
        const existing = this.committedImagePaths.get(elementId);
        const path = existing ?? (await this.imageManager.uploadImage(this.owner, this.repo, file)).path;
        this.committedImagePaths.set(elementId, path);
        srcUpdates.set(elementId, path);
      }

      // Phase 2 — apply src updates and serialize the final HTML.
      let document = this.document;
      for (const [elementId, src] of srcUpdates) {
        const outcome = this.parser.apply(document, {
          elementId,
          type: 'replace-image',
          value: src,
        });
        if (outcome.error) {
          throw new Error(outcome.error);
        }
        document = outcome.document!;
      }
      const content = this.parser.serialize(document);

      // Phase 3 — commit the HTML.
      const result = await savePage(
        this.owner,
        this.repo,
        this.pagePath,
        content,
        this.fileSha,
      );

      if (!result.success) {
        throw new Error(result.error ?? 'Failed to save the page.');
      }

      // Success — refresh state. The undo history is kept so the
      // user can continue undoing edits after a successful save.
      this.document = document;
      this.fileSha = result.sha;
      this.isDirty = false;
      this.pendingApprovalUrl = result.pendingApproval ? (result.prUrl ?? null) : null;
      this.pendingImageUploads.clear();
      this.committedImagePaths.clear();
      // The flattening edits are now committed; the re-parsed elements no
      // longer carry the markup, so the risks are realized and cleared.
      this.flattenRisks.clear();
      // Refresh the picker listing (the save may have uploaded new images).
      void this.loadImages();
    } catch (error) {
      // Machine codes, not copy: the UI maps codes to localized strings
      // (describeSaveError). Non-API errors (parser invariants, network
      // messages) pass through verbatim — they are already user-meaningful.
      this.saveError =
        error instanceof ApiClientError && MAPPED_SAVE_CODES.has(error.code)
          ? error.code
          : error instanceof Error
            ? error.message
            : 'save_failed';
    } finally {
      this.isSaving = false;
    }
  }
}