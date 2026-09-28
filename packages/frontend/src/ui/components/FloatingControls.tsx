import { useI18n } from '@/i18n';
import { useTheme } from '@/services/theme';
import './FloatingControls.css';

/**
 * Floating glass pill with language + theme toggles, used on intro/login
 * screens where the header is absent. The inner `.lang-toggle` and
 * `.theme-toggle` controls are styled globally in `styles/global.css`;
 * this component only positions the container.
 */
export function FloatingControls() {
  const { m, locale, setLocale } = useI18n();
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="floating-controls">
      <div className="lang-toggle" role="group" aria-label={m.header.languageLabel}>
        <button
          type="button"
          className={`lang-toggle__btn${locale === 'en' ? ' lang-toggle__btn--active' : ''}`}
          aria-pressed={locale === 'en'}
          onClick={() => setLocale('en')}
        >
          EN
        </button>
        <button
          type="button"
          className={`lang-toggle__btn${locale === 'fr' ? ' lang-toggle__btn--active' : ''}`}
          aria-pressed={locale === 'fr'}
          onClick={() => setLocale('fr')}
        >
          FR
        </button>
      </div>

      <button
        type="button"
        className="theme-toggle"
        aria-label={m.header.themeLabel}
        aria-pressed={theme === 'dark'}
        title={m.header.themeLabel}
        onClick={toggleTheme}
      />
    </div>
  );
}
