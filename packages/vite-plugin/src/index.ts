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
  compileFunctionComponentTsxToModule,
  LaniaTsxCompileError,
  type TsxTemplateSyntaxMode,
} from '@lania-v/compiler-tsx';
import { createFilter } from '@rollup/pluginutils';
import ts from 'typescript';
import type { Plugin, TransformResult } from 'vite';

export interface LaniaFcVitePluginOptions {
  compilerPlugins?: CompilerPlugin[];
  tsxInclude?: RegExp;
  tsxExclude?: RegExp;
  tsxTemplateSyntaxMode?: TsxTemplateSyntaxMode;
}

export type LaniaVitePluginOptions = LaniaFcVitePluginOptions;

const transpileModuleCode = (
  sourceFileName: string,
  moduleCode: string,
  jsx: ts.JsxEmit | undefined = undefined,
  transpileFileName: string = sourceFileName
): TransformResult => {
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

  const map = transpiled.sourceMapText
    ? {
        ...JSON.parse(transpiled.sourceMapText),
        // sourcemap 最终指回原始源码文件名，方便 Vite 报错与调试直接落在用户文件上。
        sources: [sourceFileName],
        sourcesContent: [moduleCode],
      }
    : null;

  return {
    code: transpiled.outputText,
    map: map as NonNullable<TransformResult extends { map?: infer T } ? T : never>,
  };
};

const compileFcModule = (
  fileName: string,
  code: string,
  options: LaniaFcVitePluginOptions
) => {
  const moduleCode = compileFunctionComponentTsxToModule(
    fileName,
    code,
    { plugins: options.compilerPlugins },
    options.tsxTemplateSyntaxMode
  );

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
}: {
  name: string;
  include: RegExp;
  exclude?: RegExp;
  compile: (fileName: string, code: string) => TransformResult;
}): Plugin => {
  const filter = createFilter(include, exclude);

  return {
    name,
    enforce: 'pre',
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
  return createLaniaCompilerPlugin({
    name: 'lania-fc-vite-plugin',
    include: options.tsxInclude ?? /\.lania\.tsx$/,
    exclude: options.tsxExclude,
    compile: (fileName, code) => compileFcModule(fileName, code, options),
  });
};

// 为旧调用点保留同名入口，但行为已收敛为 TSX-only。
export const laniaVitePlugin = (
  options: LaniaVitePluginOptions = {}
): Plugin => {
  return laniaFcVitePlugin(options);
};
