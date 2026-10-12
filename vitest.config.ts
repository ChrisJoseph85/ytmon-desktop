import { defineConfig, type UserConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': r('./src/shared'),
      '@renderer': r('./src/renderer'),
    },
  },
  // Cast once: vitest bundles its own vite copy, so the plugin option types
  // differ nominally from the top-level vite dependency.
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    globals: false,
    setupFiles: [r('./tests/setup.ts')],
    environmentMatchGlobs: [
      ['tests/renderer.test.tsx', 'jsdom'],
      ['tests/channels-policy.test.tsx', 'jsdom'],
    ],
    // The renderer suites poll and animate; the 1s default async timeout makes
    // them flaky on a loaded machine rather than on a real failure.
    asyncUtilTimeout: 5000,
  } as UserConfig['test'],
} as UserConfig);