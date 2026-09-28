import { lazy, Suspense, useState } from 'react';
import { Navigate } from 'react-router';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { AuthProvider, useAuth } from '@/services/auth';
import { AppLayout } from '@/ui/layout/AppLayout';
import { Spinner } from '@/ui/components/Spinner';
import { Background } from '@/ui/components/Background';
import { IntroOverlay } from '@/features/intro/IntroOverlay';
import { GreetingHost } from '@/features/greeting';

const RepositoriesPage = lazy(() =>
  import('@/features/repositories/RepositoriesPage').then((m) => ({ default: m.RepositoriesPage })),
);
const PagesPage = lazy(() =>
  import('@/features/pages/PagesPage').then((m) => ({ default: m.PagesPage })),
);
const EditorPage = lazy(() =>
  import('@/features/editor/EditorPage').then((m) => ({ default: m.EditorPage })),
);
const SettingsPage = lazy(() =>
  import('@/features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const OAuthCallbackPage = lazy(() =>
  import('@/features/auth/OAuthCallbackPage').then((m) => ({ default: m.OAuthCallbackPage })),
);
const PlatformOAuthCallbackPage = lazy(() =>
  import('@/features/auth/PlatformOAuthCallbackPage').then((m) => ({
    default: m.PlatformOAuthCallbackPage,
  })),
);
/**
 * The split-login screen is the guaranteed next step for a new visitor,
 * so the chunk is prefetched eagerly — the one lazy module the landing
 * route will always need.
 */
const clientLoginPageModule = import('@/features/login/ClientLoginPage');
const ClientLoginPage = lazy(() =>
  clientLoginPageModule.then((m) => ({ default: m.ClientLoginPage })),
);
const ClientPagesPage = lazy(() =>
  import('@/features/client/ClientPagesPage').then((m) => ({ default: m.ClientPagesPage })),
);
const ClientEditorPage = lazy(() =>
  import('@/features/client/ClientEditorPage').then((m) => ({ default: m.ClientEditorPage })),
);
const NotFoundPage = lazy(() =>
  import('@/ui/pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })),
);

/** Wraps lazy route elements in the shared Suspense boundary. */
function withSuspense(element: React.ReactNode) {
  return <Suspense fallback={<Spinner />}>{element}</Suspense>;
}

/**
 * The application's data router. Created once at module scope: data
 * routers must not live in React state. Route tree matches the previous
 * declarative <Routes> exactly; the layout route renders the shared
 * chrome (sidebar/header) around its children's <Outlet />.
 */
export const appRouter = createBrowserRouter([
  {
    path: '/auth/callback',
    element: withSuspense(<OAuthCallbackPage />),
  },
  {
    // Cloudflare/Vercel login finishes here (admin-only flow started from
    // Settings); exchange happens against /api/auth/platform/*.
    path: '/auth/platform/:platform/callback',
    element: withSuspense(<PlatformOAuthCallbackPage />),
  },
  {
    path: '/login',
    element: withSuspense(<ClientLoginPage />),
  },
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <LandingRoute /> },
      { path: 'repositories', element: withSuspense(<RepositoriesPage />) },
      { path: 'repositories/:owner/:repo/pages', element: withSuspense(<PagesPage />) },
      { path: 'repositories/:owner/:repo/editor/:path', element: withSuspense(<EditorPage />) },
      { path: 'settings', element: withSuspense(<SettingsPage />) },
      { path: 'client', element: withSuspense(<ClientPagesPage />) },
      { path: 'client/editor/:path', element: withSuspense(<ClientEditorPage />) },
      { path: '*', element: withSuspense(<NotFoundPage />) },
    ],
  },
]);

/**
 * Landing route for "/": sends an unauthenticated visitor to the split
 * login screen, and a signed-in user to their workspace (admin →
 * repositories, client → their pages). The redirect is a client-side
 * <Navigate> — a hard reload right as the intro fades would cause the
 * "page loads" flash the cinematic sequence is meant to avoid.
 */
function LandingRoute() {
  const { isLoading, isAuthenticated, isAdmin } = useAuth();

  // Stay quiet while the session resolves so the destination is decided
  // exactly once and without spinner churn. (The intro gates the whole
  // router below, so it has already finished by the time this renders.)
  if (isLoading) return <Spinner />;

  if (isAuthenticated) return <Navigate to={isAdmin ? '/repositories' : '/client'} replace />;
  return <Navigate to="/login" replace />;
}

/**
 * Root application component.
 *
 * Wraps the data router in the auth provider so descendant components
 * (header, guarded pages) can access the session.
 *
 * The client login page lives outside the AppLayout (standalone split
 * screen); the client workspace reuses the layout with a role-aware
 * sidebar.
 *
 * The cinematic intro overlay plays once per tab session (guarded by
 * `sessionStorage['cms.intro-seen']`); the router stays unmounted until
 * it finishes so nothing loads (no lazy chunks, no session fetch effects
 * from pages) while the story plays.
 */
export function App() {
  // Intro plays once per tab session: storage marks it seen when it ends.
  const [introDone, setIntroDone] = useState(() => {
    try {
      return sessionStorage.getItem('cms.intro-seen') === '1';
    } catch {
      return true;
    }
  });

  return (
    <AuthProvider>
      <Background />
      {introDone && <RouterProvider router={appRouter} />}
      <GreetingHost />
      {!introDone && <IntroOverlay onDone={() => setIntroDone(true)} />}
    </AuthProvider>
  );
}
