import react from '@vitejs/plugin-react';
import solid from 'vite-plugin-solid';
import { laniaFcVitePlugin } from '@lania-v/vite-plugin';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    laniaFcVitePlugin(),
    react({
      include: /\.react\.[jt]sx$/,
    }),
    solid({
      include: /\.solid\.[jt]sx$/,
    }),
  ],
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
        find: '@lania-v/runtime',
        replacement: fileURLToPath(
          new URL('../../packages/runtime/src', import.meta.url)
        ),
      },
    ],
  },
  server: {
    port: 4176,
    host: '127.0.0.1',
  },
  preview: {
    port: 4176,
    host: '127.0.0.1',
  },
});
