/**
 * 跨文件 props 类型解析。
 *
 * 编译器只处理单个 `.lania.tsx` 文件，因此 `import type { CardProps } from './card-props'`
 * 这类写法过去无法展开。这里在需要时按相对路径读取被导入文件，复用同一套
 * “类型别名 / 接口 / 交叉类型”展开逻辑。
 *
 * 边界：只解析相对路径导入的具名类型声明；`Pick<T, K>`、泛型实例化等需要
 * TypeScript 类型检查器才能展开的形态仍然不支持（会在编译期明确报错）。
 */
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

/** 已解析文件缓存：同一文件在一次进程内只解析一次。 */
const sourceFileCache = new Map<string, ts.SourceFile | null>();

const CANDIDATE_EXTENSIONS = [
  '',
  '.ts',
  '.tsx',
  '.d.ts',
  '/index.ts',
  '/index.tsx',
  '/index.d.ts',
];

const resolveModuleFile = (
  specifier: string,
  fromFileName: string
): string | null => {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    // 非相对路径（包名 / 别名）需要完整模块解析，暂不支持。
    return null;
  }

  const base = path.resolve(path.dirname(fromFileName), specifier);
  // `./types.js` 这种 ESM 写法实际对应 `.ts` 源码。
  const normalizedBase = base.endsWith('.js') ? `${base.slice(0, -3)}` : base;

  for (const extension of CANDIDATE_EXTENSIONS) {
    const candidate = `${normalizedBase}${extension}`;

    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
};

const readSourceFile = (fileName: string): ts.SourceFile | null => {
  if (sourceFileCache.has(fileName)) {
    return sourceFileCache.get(fileName) ?? null;
  }

  try {
    const text = fs.readFileSync(fileName, 'utf8');
    const sourceFile = ts.createSourceFile(
      fileName,
      text,
      ts.ScriptTarget.ESNext,
      true,
      fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    sourceFileCache.set(fileName, sourceFile);
    return sourceFile;
  } catch {
    sourceFileCache.set(fileName, null);
    return null;
  }
};

export interface ImportedTypeDeclaration {
  sourceFile: ts.SourceFile;
  declaration: ts.TypeAliasDeclaration | ts.InterfaceDeclaration;
}

/** 找出 `typeName` 在当前文件里的相对路径导入来源，并返回其声明。 */
export const resolveImportedTypeDeclaration = (
  typeName: string,
  fromSourceFile: ts.SourceFile
): ImportedTypeDeclaration | null => {
  for (const statement of fromSourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }

    const namedBindings = statement.importClause.namedBindings;

    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }

    const imported = namedBindings.elements.find((element) => {
      const localName = element.name.text;
      const importedName = element.propertyName?.text ?? localName;
      // 允许 `import { X as Y }`：本地名用于匹配 props 类型引用。
      return localName === typeName || importedName === typeName;
    });

    if (!imported) {
      continue;
    }

    const specifier = statement.moduleSpecifier
      .getText(fromSourceFile)
      .slice(1, -1);
    const resolved = resolveModuleFile(specifier, fromSourceFile.fileName);

    if (!resolved) {
      return null;
    }

    const targetSourceFile = readSourceFile(resolved);

    if (!targetSourceFile) {
      return null;
    }

    const exportedName = imported.propertyName?.text ?? imported.name.text;

    const declaration =
      targetSourceFile.statements.find(
        (candidate): candidate is ts.TypeAliasDeclaration =>
          ts.isTypeAliasDeclaration(candidate) &&
          candidate.name.text === exportedName
      ) ??
      targetSourceFile.statements.find(
        (candidate): candidate is ts.InterfaceDeclaration =>
          ts.isInterfaceDeclaration(candidate) &&
          candidate.name.text === exportedName
      );

    if (!declaration) {
      return null;
    }

    return { sourceFile: targetSourceFile, declaration };
  }

  return null;
};

/** 测试与长时间 dev 会话需要时清空缓存。 */
export const clearImportedTypeCache = (): void => {
  sourceFileCache.clear();
};
