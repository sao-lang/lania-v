/**
 * Lania Vite 插件入口。
 *
 * 当前仓库只保留 `.lania.tsx` 编译主线。
 * 这个文件负责把 TSX 编译结果接入 Vite 的 transform / HMR 生命周期。
 *
 * 职责边界很窄：
 * - 命中过滤条件时，调用编译器把 `.lania.tsx` 转成普通模块代码；
 * - 再用 TypeScript 做最小转译，产出 Vite 可继续处理的 JS 与 sourcemap；
 * - 编译失败时把错误桥接成 Vite 习惯的 `id/message/frame/loc` 结构；
 * - 热更新时直接交还 moduleGraph 相关模块，不在插件层自行推断 HMR 传播范围。
 */
import type { CompilerPlugin } from '@lania-v/compiler-core';
import {
  compileFunctionComponentTsxModule,
  LaniaTsxCompileError,
  type TsxTemplateSyntaxMode,
} from '@lania-v/compiler-tsx';
import { createFilter } from '@rollup/pluginutils';
import type { SourceMapInput } from 'rollup';
import ts from 'typescript';
import type { Plugin, ResolvedConfig } from 'vite';

interface LaniaTransformResult {
  code: string;
  map?: SourceMapInput;
}

export interface LaniaFcVitePluginOptions {
  compilerPlugins?: CompilerPlugin[];
  tsxInclude?: RegExp;
  tsxExclude?: RegExp;
  tsxTemplateSyntaxMode?: TsxTemplateSyntaxMode;
  /** Emit serializable compiler-stage snapshots into transformed modules during `vite dev`. */
  debug?: boolean;
}

export type LaniaVitePluginOptions = LaniaFcVitePluginOptions;

const transpileModuleCode = (
  sourceFileName: string,
  moduleCode: string,
  jsx: ts.JsxEmit | undefined = undefined,
  transpileFileName: string = sourceFileName
): LaniaTransformResult => {
  // 这里先把编译器生成的模块代码交给 TS 做一次最小转译，
  // 统一产出 Vite 能消费的 JS 与 sourcemap。
  const transpiled = ts.transpileModule(moduleCode, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx,
      jsxImportSource: '@lania-v/runtime',
      sourceMap: true,
      inlineSources: true,
      experimentalDecorators: true,
      useDefineForClassFields: false,
    },
    fileName: transpileFileName,
  });

  const map: SourceMapInput | undefined = transpiled.sourceMapText
    ? {
        ...JSON.parse(transpiled.sourceMapText),
        // sourcemap 最终指回原始源码文件名，方便 Vite 报错与调试直接落在用户文件上。
        sources: [sourceFileName],
        sourcesContent: [moduleCode],
      }
    : undefined;

  return {
    code: transpiled.outputText,
    map,
  };
};

const compileFcModule = (
  fileName: string,
  code: string,
  options: LaniaFcVitePluginOptions,
  includeDebugTrace: boolean
) => {
  const compiled = compileFunctionComponentTsxModule(
    fileName,
    code,
    { plugins: options.compilerPlugins },
    options.tsxTemplateSyntaxMode
  );
  let moduleCode = compiled.compiled.moduleCode;

  if (includeDebugTrace) {
    // 用对象字面量而不是 JSON 字符串，控制台里才能逐层展开；这些对象是编译期快照，不会被运行时改写。
    const traceCode = [
      `const __laniaIr = ${JSON.stringify(compiled.compiled.ir)};`,
      `const __laniaComponent = ${JSON.stringify(compiled.compiled.componentAst)};`,
      `globalThis.__laniaCompile = Object.assign(globalThis.__laniaCompile ?? {}, {`,
      `  ${JSON.stringify(compiled.compiled.className)}: {`,
      `    fileName: ${JSON.stringify(fileName)},`,
      '    source: __laniaSource,',
      '    component: __laniaComponent,',
      '    ir: __laniaIr,',
      '    renderPlan: __laniaIr.renderPlan,',
      `    moduleCode: ${JSON.stringify(moduleCode)},`,
      '  },',
      '});',
      `console.groupCollapsed(${JSON.stringify(`[lania-v] compile: ${compiled.compiled.className}`)});`,
      `console.log('TSX / FC', { fileName: ${JSON.stringify(fileName)}, source: __laniaSource, component: __laniaComponent });`,
      `console.log('Component IR', __laniaIr);`,
      `console.log('renderPlan', __laniaIr.renderPlan);`,
      `console.log('Generated module', ${JSON.stringify(moduleCode)});`,
      'console.groupEnd();',
    ].join('\n');
    const sourceLiteral = `const __laniaSource = ${JSON.stringify(code)};\n`;
    moduleCode = `${moduleCode}\n${sourceLiteral}${traceCode}\n`;
  }

  return transpileModuleCode(fileName, moduleCode, ts.JsxEmit.ReactJSX);
};

const toViteCompileError = (fileName: string, error: LaniaTsxCompileError) => {
  return {
    id: fileName,
    message: error.message,
    frame: error.frame,
    loc: {
      file: error.fileName,
      line: error.line,
      column: error.column,
    },
  };
};

const createLaniaCompilerPlugin = ({
  name,
  include,
  exclude,
  compile,
  onConfigResolved,
}: {
  name: string;
  include: RegExp;
  exclude?: RegExp;
  compile: (fileName: string, code: string) => LaniaTransformResult;
  onConfigResolved?: (config: ResolvedConfig) => void;
}): Plugin => {
  const filter = createFilter(include, exclude);

  return {
    name,
    enforce: 'pre',
    configResolved(config) {
      onConfigResolved?.(config);
    },
    // 必须在其他常规 TS/JSX 插件之前运行，先把 `.lania.tsx` 改写成普通模块代码。
    transform(code, id) {
      const fileName = id.split('?', 1)[0] ?? id;
      if (!filter(fileName)) {
        return null;
      }

      try {
        return compile(fileName, code);
      } catch (error) {
        if (error instanceof LaniaTsxCompileError) {
          const viteError = toViteCompileError(fileName, error);

          if (typeof this.error === 'function') {
            this.error(viteError);
          }

          throw Object.assign(new Error(error.message), viteError);
        }

        throw error;
      }
    },
    handleHotUpdate(ctx) {
      if (!filter(ctx.file)) {
        return;
      }

      // 直接返回关联模块集合，交给 Vite 现有 moduleGraph 决定受影响的 HMR 边界。
      return [...(ctx.server.moduleGraph.getModulesByFile(ctx.file) ?? [])];
    },
  };
};

export const laniaFcVitePlugin = (
  options: LaniaFcVitePluginOptions = {}
): Plugin => {
  let isDevServer = false;

  return createLaniaCompilerPlugin({
    name: 'lania-fc-vite-plugin',
    include: options.tsxInclude ?? /\.lania\.tsx$/,
    exclude: options.tsxExclude,
    compile: (fileName, code) =>
      compileFcModule(fileName, code, options, options.debug === true && isDevServer),
    onConfigResolved(config) {
      isDevServer = config.command === 'serve';
    },
  });
};

// 为旧调用点保留同名入口，但行为已收敛为 TSX-only。
export const laniaVitePlugin = (
  options: LaniaVitePluginOptions = {}
): Plugin => {
  return laniaFcVitePlugin(options);
};
