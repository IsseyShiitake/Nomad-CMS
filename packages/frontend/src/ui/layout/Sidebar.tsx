import { useEffect, useState } from 'react';
import { NavLink } from 'react-router';
import { config } from '@/config';
import { useAuth } from '@/services/auth';
import { useI18n } from '@/i18n';
import { useTheme } from '@/services/theme';
import { HelpCenter } from '@/features/help/HelpCenter';
import {
  CompassMark,
  ReposIcon,
  SettingsIcon,
  PagesIcon,
  HelpIcon,
  SignOutIcon,
} from '@/ui/components/icons';
import './Sidebar.css';

/**
 * Navigation rail. Persistent on desktop (the workbench's spine); an
 * off-canvas drawer below 1024px, opened from the header menu button and
 * closed on backdrop click, Escape, or navigation (handled by AppLayout).
 *
 * The footer carries the chrome that used to crowd the header: help,
 * language, theme, and the signed-in account.
 */
export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { m, locale, setLocale } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const { isClient, isAuthenticated, user, login, logout } = useAuth();
  const [helpOpen, setHelpOpen] = useState(false);

  // Escape closes the drawer while it is open (same pattern as Modal).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // Admins manage repositories and client access; clients only see their
  // pages. Help is a modal trigger, not a nav route.
  const items = isClient
    ? [{ to: '/client', label: m.nav.myPages, icon: PagesIcon }]
    : [
        { to: '/repositories', label: m.nav.repositories, icon: ReposIcon },
        { to: '/settings', label: m.nav.settings, icon: SettingsIcon },
      ];

  const brand = config.appName || m.app.name;

  return (
    <>
      {open && <div className="sidebar__backdrop" role="presentation" onMouseDown={onClose} />}
      <nav
        id="app-sidebar"
        aria-label={m.nav.mainAria}
        className={open ? 'sidebar sidebar--open' : 'sidebar'}
      >
        <div className="sidebar__brand">
          <span className="sidebar__brand-mark" aria-hidden="true">
            <CompassMark />
          </span>
          {brand}
        </div>

        <p className="sidebar__section">{m.shell.workspace}</p>
        <ul className="sidebar__nav">
          {items.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  isActive ? 'sidebar__link sidebar__link--active' : 'sidebar__link'
                }
                onClick={onClose}
              >
                <item.icon />
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>

        <div className="sidebar__footer">
          <button type="button" className="sidebar__help" onClick={() => setHelpOpen(true)}>
            <HelpIcon />
            {m.nav.help}
          </button>

          <div className="sidebar__controls">
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

          {isAuthenticated && user ? (
            <div className="sidebar__user">
              {user.avatarUrl ? (
                <img className="sidebar__avatar" src={user.avatarUrl} alt="" />
              ) : (
                <span className="sidebar__avatar" aria-hidden="true">
                  {user.login.charAt(0).toUpperCase()}
                </span>
              )}
              <span className="sidebar__user-meta">
                <span className="sidebar__user-name">{user.login}</span>
                <span className="sidebar__role">
                  {isClient ? m.shell.clientAccess : m.shell.operator}
                </span>
              </span>
              <button
                type="button"
                className="sidebar__signout"
                aria-label={m.header.signOut}
                title={m.header.signOut}
                onClick={() => void logout()}
              >
                <SignOutIcon />
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn--primary" onClick={login}>
              {m.header.signInGithub}
            </button>
          )}
        </div>
      </nav>

      <HelpCenter open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  );
}
