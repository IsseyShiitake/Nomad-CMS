import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Backend test configuration.
 *
 * Runs in a Node environment (WebCrypto, fetch, btoa/atob, TextEncoder are
 * all available in Node 18+, matching the Worker runtime). `@cms/shared` is
 * aliased to its source so tests do not require a prior build of the shared
 * package.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@cms/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
