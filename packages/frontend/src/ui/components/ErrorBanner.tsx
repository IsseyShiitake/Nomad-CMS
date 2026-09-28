import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';

/**
 * Reusable error banner.
 *
 * Renders a consistent, dismissible error message with proper
 * accessibility (role="alert"). Used across all feature pages so
 * failures are always presented the same way.
 */
export function ErrorBanner({
  children,
  onDismiss,
}: {
  children: ReactNode;
  /** Optional callback to hide the banner. */
  onDismiss?: () => void;
}) {
  const { m } = useI18n();
  return (
    <div className="error-banner" role="alert">
      <span className="error-banner__message">{children}</span>
      {onDismiss && (
        <button
          type="button"
          className="error-banner__dismiss"
          onClick={onDismiss}
          aria-label={m.common.dismissError}
        >
          ×
        </button>
      )}
    </div>
  );
}
