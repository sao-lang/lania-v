import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'vite';

import runtimePackage from '../packages/runtime/package.json';
import { isDevEnvironment, setDevEnvironmentOverride } from '@lania-v/runtime/core';

const workspaceRoot = '/Users/bytedance/Desktop/files/self/lania-zip/lania-v';
const createdTempDirs: string[] = [];
const originalHTMLElement = globalThis.HTMLElement;

const toAbsoluteImportPath = (targetFile: string): string => {
  return targetFile.split(path.sep).join('/');
};

const buildBundle = async (
  entrySource: string,
  define: Record<string, string> = {}
): Promise<string> => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lania-bundle-'));
  createdTempDirs.push(tempRoot);
  const entryFile = path.join(tempRoot, 'entry.ts');

  await writeFile(entryFile, entrySource, 'utf8');
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    define,
    build: {
      write: false,
      minify: false,
      lib: {
        entry: entryFile,
        formats: ['es'],
        fileName: () => 'bundle',
      },
      rollupOptions: {
        treeshake: true,
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((entry) => {
    return entry && 'output' in entry ? entry.output : [];
  });
  const chunk = outputs.find((entry) => entry.type === 'chunk');

  if (!chunk || !('code' in chunk)) {
    throw new Error('Bundler did not produce an output chunk.');
  }

  return chunk.code;
};

afterEach(async () => {
  setDevEnvironmentOverride(null);
  if (originalHTMLElement) {
    globalThis.HTMLElement = originalHTMLElement;
  } else {
    delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
  }
  await Promise.all(
    createdTempDirs.splice(0).map((directory) => {
      return rm(directory, {
        recursive: true,
        force: true,
      });
    })
  );
});

describe('runtime bundling', () => {
  it('exposes dedicated dev/prod entries and marks their side-effect boundaries', async () => {
    const runtimeDir = path.join(workspaceRoot, 'packages/runtime/dist/entry');
    const devEntry = pathToFileURL(path.join(runtimeDir, 'index.dev.js')).href;
    const prodEntry = pathToFileURL(path.join(runtimeDir, 'index.prod.js')).href;

    globalThis.HTMLElement = class {} as typeof HTMLElement;

    expect(runtimePackage.exports['./dev']).toBeDefined();
    expect(runtimePackage.exports['./prod']).toBeDefined();
    expect(runtimePackage.sideEffects).toEqual([
      './dist/entry/index.dev.js',
      './dist/entry/index.prod.js',
    ]);

    await import(`${devEntry}?entry=dev`);
    expect(isDevEnvironment()).toBe(true);

    await import(`${prodEntry}?entry=prod`);
    expect(isDevEnvironment()).toBe(false);
  });

  it('replaces compile-time dev constants during bundling', async () => {
    const envImport = toAbsoluteImportPath(path.join(workspaceRoot, 'packages/runtime/src/core/env.ts'));
    const bundle = await buildBundle(
      `import { __DEV__ } from ${JSON.stringify(envImport)};\nexport default __DEV__;\n`,
      {
        __LANIA_DEV__: 'false',
      }
    );

    expect(bundle).toContain('false');
    expect(bundle).not.toContain('process.env.NODE_ENV');
  });

  it('tree-shakes unrelated runtime modules when only createSignal is imported', async () => {
    const entryImport = toAbsoluteImportPath(path.join(workspaceRoot, 'packages/runtime/src/index.ts'));
    const bundle = await buildBundle(
      `import { createSignal } from ${JSON.stringify(entryImport)};\nconst count = createSignal(0);\ncount.set(1);\nexport default count();\n`
    );

    expect(bundle).toContain('createSignal');
    expect(bundle).not.toContain('IntersectionObserver');
    expect(bundle).not.toContain('lania.enhanced-component');
    expect(bundle).not.toContain('data-laniaLazy');
  });
});
