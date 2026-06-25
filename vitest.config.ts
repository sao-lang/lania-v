import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@lania-v/compiler-core',
        replacement: fileURLToPath(
          new URL('./packages/compiler-core/src/index.ts', import.meta.url)
        ),
      },
      {
        find: '@lania-v/compiler-tsx',
        replacement: fileURLToPath(
          new URL('./packages/compiler-tsx/src/index.ts', import.meta.url)
        ),
      },
      {
        find: '@lania-v/vite-plugin',
        replacement: fileURLToPath(
          new URL('./packages/vite-plugin/src/index.ts', import.meta.url)
        ),
      },
      {
        find: '@lania-v/runtime/advanced',
        replacement: fileURLToPath(
          new URL('./packages/runtime/src/entry/advanced.ts', import.meta.url)
        ),
      },
      {
        find: '@lania-v/runtime/internal',
        replacement: fileURLToPath(
          new URL('./packages/runtime/src/entry/internal.ts', import.meta.url)
        ),
      },
      {
        find: '@lania-v/runtime/testing',
        replacement: fileURLToPath(
          new URL('./packages/runtime/src/entry/testing.ts', import.meta.url)
        ),
      },
      {
        find: '@lania-v/runtime',
        replacement: fileURLToPath(new URL('./packages/runtime/src/index.ts', import.meta.url)),
      },
      {
        find: '@lania-v/shared',
        replacement: fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
      include: ['packages/**/*.ts'],
      exclude: ['**/dist/**', '**/*.d.ts']
    }
  }
});
