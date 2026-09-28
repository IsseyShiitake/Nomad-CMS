/**
 * Authentication module.
 *
 * Manages the user's session with the CMS. The backend holds all
 * GitHub credentials; the frontend only stores an opaque session
 * token and the user's public profile.
 */

export { AuthProvider, useAuth } from './AuthContext';
export type { AuthContextValue } from './AuthContext';
export {
  clearPendingPlatformLogin,
  consumePendingPlatformLogin,
  setPendingPlatformLogin,
} from './platformLoginIntent';