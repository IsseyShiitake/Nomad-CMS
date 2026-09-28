import { useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { MAX_IMAGE_BYTES, sanitizeImageFileName } from '@cms/shared';
import type { EditableElement, InsertableTag } from '@/services/htmlParser';
import { ConfirmDialog } from '@/ui/components/ConfirmDialog';
import { fmt, useI18n } from '@/i18n';
import type { Messages } from '@/i18n';

/** Element types available for insertion. */
const INSERTABLE_TAGS: InsertableTag[] = ['h1', 'h2', 'p', 'img'];

/** Human label + color class per known tag (beacon badges). */
const TAG_META: Record<string, { label: keyof Messages['editor']; className: string }> = {
  h1: { label: 'tagH1', className: 'badge--h1' },
  h2: { label: 'tagH2', className: 'badge--h2' },
  p: { label: 'tagP', className: 'badge--p' },
  img: { label: 'tagImg', className: 'badge--img' },
};

/** Callbacks wired to the editor controller. */
export interface ElementEditorCallbacks {
  onEditText: (elementId: string, value: string) => void;
  onReplaceImage: (elementId: string, src: string) => void;
  /** Registers a local image file for upload on the next save. */
  onImageFile: (elementId: string, file: File) => void;
  onInsertAbove: (elementId: string, tag: InsertableTag) => void;
  onInsertBelow: (elementId: string, tag: InsertableTag) => void;
  onDelete: (elementId: string) => void;
}

/**
 * A single editable element row.
 *
 * Text elements expose an auto-growing multi-line textarea; images expose a
 * src input plus a file picker that queues a local image for upload on
 * the next save. Every row also offers delete and insert above/below
 * with a tag selector (h1, h2, p, img). All edits are applied in
 * memory and reflected immediately in the live preview.
 *
 * Each row carries a color-coded, human-labeled badge (a beacon) so
 * non-technical users can tell at a glance what each block is.
 */
export function ElementEditor({
  element,
  callbacks,
  isActive,
  onActivate,
}: {
  element: EditableElement;
  callbacks: ElementEditorCallbacks;
  /** True when this row matches the element last clicked (preview or panel). */
  isActive: boolean;
  /** Marks this row active (preview scrolls to the matching area). */
  onActivate: (elementId: string) => void;
}) {
  const { m } = useI18n();
  const isImage = element.tagName === 'img';
  const [insertTag, setInsertTag] = useState<InsertableTag>('h1');
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  /** Refs: hidden image picker, auto-growing textarea, and the row itself. */
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const liRef = useRef<HTMLLIElement | null>(null);

  const meta = TAG_META[element.tagName];
  const typeLabel = meta ? m.editor[meta.label] : element.tagName;
  const badgeClass = meta ? `editor-element__type badge ${meta.className}` : 'editor-element__type';

  // The textarea's controlled value (line breaks preserved via <br> round-trip).
  const textValue = isImage ? null : (element.textContent ?? '');

  // Auto-grow the textarea to fit its content (on mount + value/id change).
  useLayoutEffect(() => {
    const el = textAreaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [textValue, element.id]);

  // Center the row in the viewport when activated — by a preview click or
  // a direct panel click (optional call — jsdom lacks scrollIntoView).
  useLayoutEffect(() => {
    if (isActive) liRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [isActive]);

  /** Handles a selected local image file.
   *
   * Client-side pre-checks mirror the backend gates (extension allowlist,
   * MAX_IMAGE_BYTES) so an invalid pick is rejected before it is ever
   * queued — instead of uploading fully and failing at save time. */
  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (file.size > MAX_IMAGE_BYTES) {
        setFileName(null);
        setFileError(m.editor.imageTooLarge);
      } else if (!sanitizeImageFileName(file.name)) {
        setFileName(null);
        setFileError(m.editor.imageTypeRejected);
      } else {
        // Capture the name BEFORE resetting so the UI can show what was queued.
        setFileName(file.name);
        setFileError(null);
        callbacks.onImageFile(element.id, file);
      }
    }
    // Reset so selecting the same file again re-triggers the change.
    event.target.value = '';
  };

  return (
    <li
      ref={liRef}
      className={`editor-element editor-mood__row${isActive ? ' editor-element--active' : ''}`}
      key={element.id}
      onClick={() => onActivate(element.id)}
    >
      <div className="editor-element__top">
        <span className={badgeClass}>{typeLabel}</span>
        <button
          type="button"
          className="editor-element__delete"
          onClick={() => setIsDeleteConfirmOpen(true)}
          title={m.editor.deleteTitle}
        >
          {m.common.delete}
        </button>
      </div>

      <div className="editor-element__body">
        {isImage ? (
          <>
            <div className="editor-element__image-row">
              <input
                className="editor-element__input"
                type="text"
                value={element.src ?? ''}
                placeholder={m.editor.imageSrc}
                aria-label={m.editor.imageSrc}
                onChange={(event) => callbacks.onReplaceImage(element.id, event.target.value)}
              />
              <button
                type="button"
                className="editor-element__browse"
                aria-label={m.editor.uploadImage}
                onClick={() => fileInputRef.current?.click()}
              >
                {m.editor.browseFile}
              </button>
            </div>
            <span className="editor-element__filename">
              {fileName ?? m.editor.noFileSelected}
            </span>
            {fileError && (
              <span className="editor-element__filename editor-element__file-error" role="alert">
                {fileError}
              </span>
            )}
            <input
              ref={fileInputRef}
              className="editor-element__file"
              type="file"
              // The shared backend allowlist (SVG deliberately excluded —
              // stored-XSS risk): restrict the picker so invalid picks are
              // mostly impossible instead of failing at save time.
              accept=".png,.jpg,.jpeg,.gif,.webp,.avif"
              tabIndex={-1}
              onChange={handleFileChange}
            />
          </>
        ) : (
          <textarea
            ref={textAreaRef}
            className="editor-element__textarea"
            rows={1}
            value={textValue ?? ''}
            placeholder={fmt(m.editor.textPlaceholder, { tag: element.tagName })}
            aria-label={fmt(m.editor.textPlaceholder, { tag: element.tagName })}
            onChange={(event) => callbacks.onEditText(element.id, event.target.value)}
          />
        )}
      </div>

      <div className="editor-element__insert">
        <select
          className="editor-element__tag"
          value={insertTag}
          aria-label={m.editor.insertType}
          onChange={(event) => setInsertTag(event.target.value as InsertableTag)}
        >
          {INSERTABLE_TAGS.map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => callbacks.onInsertAbove(element.id, insertTag)}>
          {m.editor.insertAbove}
        </button>
        <button type="button" onClick={() => callbacks.onInsertBelow(element.id, insertTag)}>
          {m.editor.insertBelow}
        </button>
      </div>

      <ConfirmDialog
        open={isDeleteConfirmOpen}
        title={m.editor.deleteTitle}
        message={fmt(m.editor.deleteMessage, { tag: typeLabel })}
        confirmLabel={m.common.delete}
        cancelLabel={m.common.cancel}
        onConfirm={() => {
          setIsDeleteConfirmOpen(false);
          callbacks.onDelete(element.id);
        }}
        onCancel={() => setIsDeleteConfirmOpen(false)}
      />
    </li>
  );
}
