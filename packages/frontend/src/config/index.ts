/**
 * Frontend configuration.
 *
 * Centralizes all environment-derived configuration for the
 * frontend. Values are read from Vite's import.meta.env at build
 * time. No secrets belong here — the backend holds all
 * credentials.
 */

/** Public configuration exposed to the frontend. */
export interface AppConfig {
  /** Base URL of the API. Empty string means same-origin (dev proxy). */
  apiBaseUrl: string;

  /** Application name shown in the UI. */
  appName: string;
}

/**
 * Loads configuration from environment variables.
 *
 * Vite exposes variables prefixed VITE_ on import.meta.env.
 * Defaults keep the app runnable without any .env file.
 */
export function loadConfig(): AppConfig {
  return {
    apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
    appName: import.meta.env.VITE_APP_NAME ?? 'Nomad CMS',
  };
}

/** Singleton config instance, loaded once at startup. */
export const config: AppConfig = loadConfig();
