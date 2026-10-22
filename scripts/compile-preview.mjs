/**
 * 把单个 *.lania.tsx 编译成人可读的产物，不经过 vite/rollup 打包。
 *
 * 用法:
 *   node scripts/compile-preview.mjs <输入文件> [输出目录]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compileFunctionComponentTsx,
  emitFunctionComponentTsxModule,
} from '@lania-v/compiler-tsx';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inputFile = process.argv[2];

if (!inputFile) {
  console.error('用法: node scripts/compile-preview.mjs <输入文件> [输出目录]');
  process.exit(1);
}

const absoluteInput = resolve(process.cwd(), inputFile);
const source = readFileSync(absoluteInput, 'utf8');
const fileName = relative(root, absoluteInput).replace(/\\/g, '/');

const outDir = resolve(process.cwd(), process.argv[3] ?? 'compile-preview-out');
mkdirSync(outDir, { recursive: true });

const stem = basename(absoluteInput).replace(/\.lania\.tsx$/, '');

const compiled = compileFunctionComponentTsx(fileName, source);
const emitted = emitFunctionComponentTsxModule(fileName, source, compiled);

const write = (name, content) => {
  const file = join(outDir, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return relative(process.cwd(), file);
};

const written = [];

const entryClass =
  compiled.componentClasses.find(
    (entry) => entry.className === compiled.className
  ) ?? compiled.componentClasses[0];

if (entryClass) {
  for (const [key, value] of Object.entries(entryClass.classCode)) {
    if (typeof value === 'string' && value.trim()) {
      written.push(write(`${stem}.${key}.ts`, value));
    }
  }
}

written.push(write(`${stem}.module.ts`, emitted.moduleCode));
written.push(write(`${stem}.static-html.html`, compiled.staticHtml));
written.push(
  write(
    `${stem}.text-bindings.json`,
    JSON.stringify(compiled.textBindings, null, 2)
  )
);
written.push(write(`${stem}.ir.json`, JSON.stringify(compiled.ir, null, 2)));

const tagName = compiled.className
  .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
  .toLowerCase();
const readme = [
  `# ${fileName}`,
  '',
  `- 入口组件: \`${compiled.className}\`（自定义元素 \`<${tagName}>\`）`,
  `- 文件内组件: ${compiled.classNames.map((name) => `\`${name}\``).join(', ')}`,
  '',
  '| 文件 | 内容 |',
  '| --- | --- |',
  `| \`${stem}.static-html.html\` | 编译期生成的静态模板字符串（带 slot 锚点注释） |`,
  `| \`${stem}.module.ts\` | 最终 ES 模块：import 收口 + 静态模板常量 + 组件类 |`,
  `| \`${stem}.classBody.ts\` | 只含类体（setup 状态、生命周期、slot 更新器） |`,
  `| \`${stem}.code.ts\` | 组件类代码的整体产出 |`,
  `| \`${stem}.text-bindings.json\` | 文本槽绑定计划 |`,
  `| \`${stem}.ir.json\` | 组件 IR（renderPlan / 绑定 / 依赖图） |`,
  '',
].join('\n');

written.push(write(`${stem}.README.md`, readme));

console.log(`\n✅ ${fileName} -> ${relative(process.cwd(), outDir)}\n`);
for (const file of written) console.log(`  - ${file}`);
