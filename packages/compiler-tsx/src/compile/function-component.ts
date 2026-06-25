/**
 * 函数组件 TSX 编译入口。
 *
 * 这里把“函数组件源码 -> 可执行模块”的链路拆成三层能力：
 * 1. `compileFunctionComponentTsx` 负责解析并跑通 compiler-core 流水线；
 * 2. `compileFunctionComponentTsxToModule` 直接返回模块代码文本；
 * 3. `compileFunctionComponentTsxModule` 额外补齐 source map，供集成层消费。
 *
 * 也就是说，这里是 TSX 编译侧最薄的一层 orchestrator:
 * 上游负责把源码解析成统一组件声明，下游负责把 IR 继续落成类代码和模块文本。
 */
import {
  generateClassComponentCode,
  runComponentCompilerPipeline,
  type ClassComponentCodegenResult,
  type CompilerPluginOptions,
  type CompilerProgram,
  type ComponentDeclaration,
  type ComponentIR,
  type RenderCodegenResult,
  type RenderTextBindingPlan,
} from '@lania-v/compiler-core';
import {
  createCompiledTsxModuleMap,
  emitFunctionComponentTsxModule,
  type CompiledTsxModule,
} from './module-output';
import { LaniaTsxCompileError, wrapLaniaTsxCompileError } from './errors';
import { parseFunctionComponentTsx } from '../parse/function';
import type { TsxTemplateSyntaxMode } from '../parse/template-mode';

export interface TsxFunctionTextBindingPlan extends RenderTextBindingPlan {}

export interface CompiledTsxFunctionComponent {
  className: string;
  program: CompilerProgram;
  componentAst: ComponentDeclaration;
  ir: ComponentIR;
  // staticHtml/textBindings 与 renderCode 一起构成运行时与调试都要读取的核心产物。
  staticHtml: string;
  textBindings: TsxFunctionTextBindingPlan[];
  renderCode: RenderCodegenResult;
  ssrCode: ClassComponentCodegenResult['ssrCode'];
  classCode: ClassComponentCodegenResult;
}

/** 解析函数组件 TSX，并生成渲染计划与类代码。 */
export const compileFunctionComponentTsx = (
  fileName: string,
  source: string,
  options: CompilerPluginOptions = {},
  mode: TsxTemplateSyntaxMode = 'jsx-standard'
): CompiledTsxFunctionComponent => {
  try {
    // 先把 TSX 源码压成统一 Program，再交给 compiler-core 继续做 lowering/codegen。
    const parsed = parseFunctionComponentTsx(fileName, source, mode);
    const pipeline = runComponentCompilerPipeline(parsed.program, options);
    // TSX 入口一次只编译一个组件，因此直接取首个产物。
    const artifact = pipeline.components[0];

    if (!artifact) {
      throw new Error('Compiler pipeline did not produce a component artifact.');
    }

    // 函数组件最终仍会落成统一的类组件代码模型，便于复用运行时与 SSR 产物结构。
    const classCode = generateClassComponentCode(artifact.component);

    return {
      className: parsed.component.name,
      program: parsed.program,
      componentAst: parsed.component,
      ir: artifact.component,
      staticHtml: artifact.component.renderPlan.staticHtml,
      textBindings: artifact.component.renderPlan.textBindings,
      renderCode: artifact.renderCode,
      classCode,
      ssrCode: classCode.ssrCode,
    };
  } catch (error) {
    // 入口层只保留统一错误模型，避免集成层处理多种裸异常。
    if (error instanceof LaniaTsxCompileError) {
      throw error;
    }

    throw wrapLaniaTsxCompileError(fileName, source, error);
  }
};

/** 解析函数组件 TSX，并直接组装出供集成层消费的模块代码。 */
export const compileFunctionComponentTsxToModule = (
  fileName: string,
  source: string,
  options: CompilerPluginOptions = {},
  mode: TsxTemplateSyntaxMode = 'jsx-standard'
): string => {
  const compiled = compileFunctionComponentTsx(fileName, source, options, mode);
  return emitFunctionComponentTsxModule(fileName, source, compiled).moduleCode;
};

/** 编译函数组件 TSX，并返回带 source map 的模块结果。 */
export const compileFunctionComponentTsxModule = (
  fileName: string,
  source: string,
  options: CompilerPluginOptions = {},
  mode: TsxTemplateSyntaxMode = 'jsx-standard'
): CompiledTsxModule => {
  const compiled = emitFunctionComponentTsxModule(
    fileName,
    source,
    compileFunctionComponentTsx(fileName, source, options, mode)
  );

  return {
    code: compiled.moduleCode,
    map: createCompiledTsxModuleMap(fileName, source, compiled.moduleCode),
    compiled,
  };
};
