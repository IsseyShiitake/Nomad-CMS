import { useState } from 'react';
import { Link } from 'react-router';
import { config } from '@/config';
import { useAuth } from '@/services/auth';
import { useI18n } from '@/i18n';
import { useTheme } from '@/services/theme';
import { HelpCenter } from '@/features/help/HelpCenter';
import './Header.css';

/** Application header: menu toggle, app name, language toggle, help, user actions. */
export function Header({
  sidebarOpen,
  onToggleSidebar,
}: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}) {
  const { m, locale, setLocale } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const { user, isAuthenticated, isLoading, login, logout } = useAuth();
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <header className="header">
      <div className="header__lead">
        <button
          type="button"
          className="header__menu-toggle"
          aria-controls="app-sidebar"
          aria-expanded={sidebarOpen}
          aria-label={sidebarOpen ? m.nav.closeMenu : m.nav.openMenu}
          onClick={onToggleSidebar}
        >
          <span className="header__menu-line" />
          <span className="header__menu-line" />
          <span className="header__menu-line" />
        </button>
        <div className="header__title">{config.appName || m.app.name}</div>
      </div>
      <div className="header__user">
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
        <button
          type="button"
          className="header__button header__help"
          aria-label={m.help.openLabel}
          onClick={() => setHelpOpen(true)}
        >
          {m.nav.help}
        </button>

        {isLoading ? (
          <span className="header__guest">{m.common.loading}</span>
        ) : isAuthenticated && user ? (
          <>
            <span className="header__username">{user.login}</span>
            <button type="button" className="header__button" onClick={() => void logout()}>
              {m.header.signOut}
            </button>
          </>
        ) : (
          <>
            <Link className="header__client-link" to="/login">
              {m.auth.clientLink}
            </Link>
            <button type="button" className="header__button header__button--primary" onClick={login}>
              {m.header.signInGithub}
            </button>
          </>
        )}
      </div>

      <HelpCenter open={helpOpen} onClose={() => setHelpOpen(false)} />
    </header>
  );
}
