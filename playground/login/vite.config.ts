import { laniaFcVitePlugin } from '@lania-v/vite-plugin';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [laniaFcVitePlugin({ debug: true })],
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: '@lania-v/runtime',
  },
  resolve: {
    dedupe: ['axios'],
    alias: [
      {
        find: '@lania-v/runtime/jsx-dev-runtime',
        replacement: fileURLToPath(
          new URL('../../packages/runtime/src/entry/jsx-dev-runtime.ts', import.meta.url)
        ),
      },
      {
        find: '@lania-v/runtime/jsx-runtime',
        replacement: fileURLToPath(
          new URL('../../packages/runtime/src/entry/jsx-runtime.ts', import.meta.url)
        ),
      },
      {
        find: '@lania-v/runtime/advanced',
        replacement: fileURLToPath(
          new URL('../../packages/runtime/src/entry/advanced.ts', import.meta.url)
        ),
      },
      {
        find: '@lania-v/runtime/internal',
        replacement: fileURLToPath(
          new URL('../../packages/runtime/src/entry/internal.ts', import.meta.url)
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
    port: 4175,
    host: '127.0.0.1',
  },
  optimizeDeps: {
    // lania-tools 以链接方式接入（dist 为预构建 ESM），显式预打包避免二次转换。
    include: ['@lania-tools/tools/axios-wrapper', 'axios'],
  },
});
