import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = process.cwd();
const gitDir = resolve(root, '.git');

if (!existsSync(gitDir)) {
  console.log('[prepare] skip husky install because .git is missing');
  process.exit(0);
}

const result = spawnSync('npx', ['--no-install', 'husky'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 0);
