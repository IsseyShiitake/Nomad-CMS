import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { RepoRef, SessionInfo, SessionKind, UserProfile } from '@cms/shared';
import { clientLogin as apiClientLogin, getSession, logout as apiLogout, setUnauthorizedHandler, startOAuthLogin } from '@/api';
import { useI18n } from '@/i18n';

/**
 * Authentication context.
 *
 * Manages the current session for the frontend. The session token lives in
 * an HttpOnly cookie set by the Worker; JavaScript cannot read it, and the
 * browser sends it automatically with credentialed API requests. The
 * frontend therefore tracks only the public session info (profile, kind,
 * repository lock).
 */

/** Shape of the auth context value. */
export interface AuthContextValue {
  /** Whether the session is still being restored on startup. */
  isLoading: boolean;

  /** The full session info, or null when logged out. */
  session: SessionInfo | null;

  /** The authenticated user, or null when logged out. */
  user: UserProfile | null;

  /** Whether the user is currently authenticated. */
  isAuthenticated: boolean;

  /** The session kind, or null when logged out. */
  kind: SessionKind | null;

  /** Whether the session is an admin (GitHub) session. */
  isAdmin: boolean;

  /** Whether the session is a client access session. */
  isClient: boolean;

  /** The repository a client session is locked to (null for admin). */
  repoLock: RepoRef | null;

  /** Redirects the browser to GitHub's OAuth authorization page. */
  login: () => void;

  /** Signs in a client with access ID + password. Throws ApiClientError. */
  loginClient: (clientId: string, password: string) => Promise<void>;

  /** Persists a session obtained from the OAuth code exchange. */
  applySession: (info: SessionInfo) => void;

  /** Logs the user out and clears the session. */
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Provider that supplies the auth context to the app. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const { setLocale } = useI18n();

  /**
   * Applies a client session's stored language preference: the operator
   * sets it per access in Settings, so it wins over whatever locale this
   * browser last used. Admin sessions never apply a language — they keep
   * the browser's last-chosen locale (a client's applied language does
   * persist in localStorage until an admin manually switches it back).
   */
  const applySessionLanguage = useCallback(
    (info: SessionInfo | null) => {
      if (info?.kind === 'client' && (info.language === 'en' || info.language === 'fr')) {
        setLocale(info.language);
      }
    },
    [setLocale],
  );

  /** Stores the session and applies its stored language preference. */
  const adoptSession = useCallback(
    (info: SessionInfo | null) => {
      setSession(info);
      applySessionLanguage(info);
    },
    [applySessionLanguage],
  );

  // Restore the session on startup via the cookie-backed endpoint.
  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      try {
        const current = await getSession();
        if (!cancelled) {
          adoptSession(current);
        }
      } catch {
        // Treat a failed validation the same as logged out.
        if (!cancelled) {
          setSession(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void restoreSession();
    return () => {
      cancelled = true;
    };
  }, [adoptSession]);

  // A 401 from any non-auth endpoint means the session died server-side:
  // drop the local session state so the guarded routes show the sign-in
  // screen — no hard reload (it would bypass the editor's navigation guard).
  useEffect(() => {
    setUnauthorizedHandler(() => setSession(null));
    return () => setUnauthorizedHandler(null);
  }, []);

  /** Redirects the browser to the server-issued GitHub authorization URL. */
  const login = useCallback(async () => {
    const { url } = await startOAuthLogin();
    window.location.href = url;
  }, []);

  /** Signs in a client with access ID + password. */
  const loginClient = useCallback(
    async (clientId: string, password: string) => {
      const info = await apiClientLogin(clientId, password);
      adoptSession(info);
    },
    [adoptSession],
  );

  /** Persists a session obtained from the OAuth code exchange. */
  const applySession = useCallback(
    (info: SessionInfo) => {
      adoptSession(info);
    },
    [adoptSession],
  );

  /** Logs the user out. */
  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch {
      // Even if the server call fails, clear local state.
    }
    setSession(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      isLoading,
      session,
      user: session?.user ?? null,
      isAuthenticated: session !== null,
      kind: session?.kind ?? null,
      isAdmin: session?.kind === 'admin',
      isClient: session?.kind === 'client',
      repoLock: session?.repoLock ?? null,
      login,
      loginClient,
      applySession,
      logout,
    }),
    [isLoading, session, login, loginClient, applySession, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Hook to access the auth context. */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
