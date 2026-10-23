import { laniaFcVitePlugin } from '@lania-v/vite-plugin';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [laniaFcVitePlugin()],
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: '@lania-v/runtime',
  },
  resolve: {
    alias: [
      {
        find: '@lania-v/runtime/jsx-dev-runtime',
        replacement: fileURLToPath(
          new URL(
            '../../packages/runtime/src/entry/jsx-dev-runtime.ts',
            import.meta.url
          )
        ),
      },
      {
        find: '@lania-v/runtime/jsx-runtime',
        replacement: fileURLToPath(
          new URL(
            '../../packages/runtime/src/entry/jsx-runtime.ts',
            import.meta.url
          )
        ),
      },
      {
        find: '@lania-v/runtime/advanced',
        replacement: fileURLToPath(
          new URL(
            '../../packages/runtime/src/entry/advanced.ts',
            import.meta.url
          )
        ),
      },
      {
        find: '@lania-v/runtime/internal',
        replacement: fileURLToPath(
          new URL(
            '../../packages/runtime/src/entry/internal.ts',
            import.meta.url
          )
        ),
      },
      {
        find: '@lania-v/advanced',
        replacement: fileURLToPath(
          new URL('../../packages/advanced/src', import.meta.url)
        ),
      },
      {
        find: '@lania-v/reactivity',
        replacement: fileURLToPath(
          new URL('../../packages/reactivity/src', import.meta.url)
        ),
      },
      {
        find: '@lania-v/runtime',
        replacement: fileURLToPath(
          new URL('../../packages/runtime/src', import.meta.url)
        ),
      },
      {
        find: '@lania-v/store',
        replacement: fileURLToPath(
          new URL('../../packages/store/src', import.meta.url)
        ),
      },
    ],
  },
  server: {
    port: 4173,
    host: '127.0.0.1',
  },
});
