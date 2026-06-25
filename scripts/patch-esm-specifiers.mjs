import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Patch emitted ESM JS to be Node-resolvable.
 *
 * The repo builds TS with `moduleResolution: Bundler`, so tsc keeps specifiers like:
 *   export * from './ast';
 * Node ESM does NOT resolve extensionless or directory specifiers.
 *
 * This script rewrites relative specifiers without an extension to:
 * - `./x.js` if `<dir>/x.js` exists
 * - `./x/index.js` if `<dir>/x/index.js` exists
 */
const isRelative = (specifier) =>
  specifier.startsWith('./') || specifier.startsWith('../');

const hasExtension = (specifier) => path.extname(specifier).length > 0;

const fileExists = async (filePath) => {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
};

const resolveTarget = async (baseDir, specifier) => {
  const directJs = path.resolve(baseDir, `${specifier}.js`);
  if (await fileExists(directJs)) {
    return `${specifier}.js`;
  }

  const indexJs = path.resolve(baseDir, specifier, 'index.js');
  if (await fileExists(indexJs)) {
    return `${specifier}/index.js`;
  }

  return null;
};

const rewriteInFile = async (filePath) => {
  const original = await fs.readFile(filePath, 'utf8');
  let updated = original;

  // Handles:
  // - import x from './x'
  // - export * from "./x"
  // - import('./x')
  const patterns = [
    // from '...'
    /(\bfrom\s+)(['"])(\.{1,2}\/[^'"]+)\2/g,
    // import('...')
    /(\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2(\s*\))/g,
  ];

  for (const pattern of patterns) {
    const matches = [...updated.matchAll(pattern)];
    for (const match of matches) {
      const specifier = match[3];
      if (!isRelative(specifier) || hasExtension(specifier)) {
        continue;
      }
      const baseDir = path.dirname(filePath);
      const resolved = await resolveTarget(baseDir, specifier);
      if (!resolved) {
        continue;
      }
      // Replace only this occurrence (safe because match is exact substring).
      updated = updated.replace(match[0], match[0].replace(specifier, resolved));
    }
  }

  if (updated !== original) {
    await fs.writeFile(filePath, updated, 'utf8');
    return true;
  }
  return false;
};

const walk = async (dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
      continue;
    }
    if (entry.isFile() && full.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
};

const main = async () => {
  const distDir = process.argv[2];
  if (!distDir) {
    console.error('Usage: node scripts/patch-esm-specifiers.mjs <distDir>');
    process.exit(1);
  }
  const root = path.resolve(process.cwd(), distDir);
  const files = await walk(root);

  let touched = 0;
  for (const file of files) {
    if (await rewriteInFile(file)) {
      touched += 1;
    }
  }
  console.log(`[patch-esm-specifiers] patched ${touched} file(s) under ${distDir}`);
};

await main();

