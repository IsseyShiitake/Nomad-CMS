import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';

/**
 * Reusable modal dialog.
 *
 * Renders an overlay + centered dialog. Closes on overlay click and on
 * Escape. The dialog is only rendered when `open` is true.
 *
 * The overlay is portaled to document.body: `position: fixed` is
 * contained by any ancestor with a filter/backdrop-filter/transform (the
 * app header has one), so an in-place overlay inside such an ancestor
 * would be sized and centered against that ancestor instead of the
 * viewport — the dialog would hug the top of the screen.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  /** Whether the modal is visible. */
  open: boolean;
  /** Dialog title. */
  title: string;
  /** Called when the user closes the modal. */
  onClose: () => void;
  /** Dialog body. */
  children: ReactNode;
  /** Optional footer actions. */
  footer?: ReactNode;
}) {
  const { m } = useI18n();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="modal__overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__header">
          <h3 className="modal__title">{title}</h3>
          <button type="button" className="modal__close" onClick={onClose} aria-label={m.common.close}>
            ×
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
