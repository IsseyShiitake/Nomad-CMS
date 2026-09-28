import { useI18n } from '@/i18n';

/**
 * Reusable loading spinner.
 *
 * Renders an accessible inline spinner with an optional label.
 * Used in place of plain "Loading…" text so every async state in
 * the CMS has a consistent visual indicator.
 */
export function Spinner({ label }: { label?: string }) {
  const { m } = useI18n();
  return (
    <span className="spinner" role="status" aria-live="polite">
      <span className="spinner__indicator" aria-hidden="true">
        <span className="spinner__dot" />
        <span className="spinner__dot" />
        <span className="spinner__dot" />
      </span>
      <span className="spinner__label">{label ?? m.common.loading}</span>
    </span>
  );
}
