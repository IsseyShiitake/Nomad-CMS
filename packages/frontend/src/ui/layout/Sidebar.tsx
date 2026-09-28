import { useEffect } from 'react';
import { NavLink } from 'react-router';
import { config } from '@/config';
import { useAuth } from '@/services/auth';
import { useI18n } from '@/i18n';
import './Sidebar.css';

/**
 * Off-canvas navigation drawer (closed by default).
 *
 * Opens over a dimmed backdrop from the header menu button; closes on
 * backdrop click, Escape, or navigation (handled by AppLayout).
 */
export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { m } = useI18n();
  const { isClient } = useAuth();

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
  // pages. Help is a header modal trigger, not a nav route.
  const items = isClient
    ? [{ to: '/client', label: m.nav.myPages }]
    : [
        { to: '/repositories', label: m.nav.repositories },
        { to: '/settings', label: m.nav.settings },
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
            {brand.charAt(0)}
          </span>
          {brand}
        </div>
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
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
