/// <reference types="vite/client" />

/**
 * Typed environment variables for the frontend.
 *
 * Only public values are exposed here. Never add secrets to this
 * file or to any VITE_ variable — credentials live exclusively in
 * the backend.
 */
interface ImportMetaEnv {
  /** Base URL of the API. Empty string means same-origin. */
  readonly VITE_API_BASE_URL?: string;

  /** Application name shown in the UI. */
  readonly VITE_APP_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
