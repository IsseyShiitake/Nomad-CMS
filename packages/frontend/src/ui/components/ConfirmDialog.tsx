import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';

/**
 * Reusable confirmation dialog.
 *
 * Renders a modal overlay asking the user to confirm a destructive
 * or otherwise meaningful action. The dialog is only rendered when
 * `open` is true; callers control visibility and the confirm/cancel
 * callbacks.
 *
 * The overlay is portaled to document.body and closes on Escape, exactly
 * like Modal: `position: fixed` is contained by any ancestor with a
 * filter/backdrop-filter/transform, so an in-place overlay inside such an
 * ancestor would be sized against the ancestor instead of the viewport.
 * (Current usages sit outside filtered ancestors; this keeps the next
 * usage safe by construction.)
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: {
  /** Whether the dialog is visible. */
  open: boolean;
  /** Dialog title. */
  title: string;
  /** Child content (description or extra context). */
  message: ReactNode;
  /** Label for the confirm button (defaults to the translated "Confirm"). */
  confirmLabel?: string;
  /** Label for the cancel button (defaults to the translated "Cancel"). */
  cancelLabel?: string;
  /** Called when the user confirms. */
  onConfirm: () => void;
  /** Called when the user cancels or dismisses. */
  onCancel: () => void;
}) {
  const { m } = useI18n();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return createPortal(
    <div className="confirm-dialog__overlay" role="presentation" onMouseDown={onCancel}>
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h3 className="confirm-dialog__title" id="confirm-dialog-title">
          {title}
        </h3>
        <div className="confirm-dialog__message">{message}</div>
        <div className="confirm-dialog__actions">
          <button type="button" className="btn" onClick={onCancel}>
            {cancelLabel ?? m.common.cancel}
          </button>
          <button type="button" className="btn btn--danger" onClick={onConfirm}>
            {confirmLabel ?? m.common.confirm}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
