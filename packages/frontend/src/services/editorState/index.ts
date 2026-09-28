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
import type { ImageManager } from '@/services/images';

/**
 * Backend error codes mapped to machine codes (describeSaveError
 * localizes them). Everything else surfaces the backend/parser message —
 * without this set, French users would see raw English API messages.
 */
const MAPPED_SAVE_CODES = new Set([
  'merge_conflict',
  'rate_limited',
  'file_too_large',
  'invalid_content',
  'invalid_path',
  'repo_too_large',
]);

import type {
  EditOperation,
  EditOutcome,
  EditableDocument,
  HtmlParser,
  ScanMode,
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

  /** Document snapshots for undo, most recent last. */
  private readonly undoStack: EditableDocument[] = [];

  pagePath = '';
  document: EditableDocument | null = null;
  isDirty = false;
  isSaving = false;
  saveError: string | null = null;
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
    this.pendingImageUploads.clear();
    this.committedImagePaths.clear();
    this.undoStack.length = 0;
    this.canUndo = false;

    return document;
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
    const outcome = this.parser.apply(this.document, operation);
    this.document = outcome.document;
    this.saveError = outcome.error;

    // Successful edits mark the document dirty and push an undo snapshot.
    // Failed operations leave the document untouched — and must NOT clear an
    // existing dirty flag, or a failed edit would lock the Save button while
    // unsaved changes remain.
    if (outcome.error == null) {
      this.isDirty = true;
      this.undoStack.push(previous);
      this.canUndo = true;
    }

    return outcome;
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

    this.document = previous;
    this.isDirty = true;
    this.saveError = null;

    // Image uploads queued for an undone edit remain pending: the
    // user may re-apply the edit, and uploads are only committed on
    // save. Undoing a document change does not discard queued files.
    this.canUndo = this.undoStack.length > 0;
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
  async save(): Promise<void> {
    // Re-entrancy guard: a second save while one is in flight would race
    // the same base sha into GitHub (a false merge conflict for the user
    // whose commit actually landed) and double-fire auto-publish.
    if (this.isSaving) return;
    if (!this.document) {
      this.saveError = 'No page loaded.';
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
      this.pendingImageUploads.clear();
      this.committedImagePaths.clear();
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