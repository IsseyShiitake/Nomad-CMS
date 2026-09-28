import { Suspense, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { Spinner } from '@/ui/components/Spinner';

/**
 * Application layout: off-canvas sidebar drawer + header + feature page
 * outlet. The drawer is closed by default so the content area gets the
 * full width (desktop-width editor preview); it opens from the header
 * menu button and closes on navigation, backdrop click, or Escape.
 *
 * The outlet sits inside a Suspense boundary: feature pages are lazy
 * chunks, and the data router does not provide a boundary for them.
 */
export function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  // Close the drawer whenever the route changes.
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  return (
    <div className="app-layout">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="app-layout__main">
        <Header
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
        />
        <main className="app-layout__content">
          <Suspense fallback={<Spinner />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
