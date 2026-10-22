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

export interface TsxFunctionTextBindingPlan extends RenderTextBindingPlan {}

export interface CompiledTsxFunctionComponent {
  /** 编译入口组件的类名（`export default` 指向的组件）。 */
  className: string;
  /** 文件里所有组件类名，按源码顺序。 */
  classNames: string[];
  program: CompilerProgram;
  componentAst: ComponentDeclaration;
  /** 入口组件的 IR。 */
  ir: ComponentIR;
  staticHtml: string;
  textBindings: TsxFunctionTextBindingPlan[];
  renderCode: RenderCodegenResult;
  ssrCode: ClassComponentCodegenResult['ssrCode'];
  classCode: ClassComponentCodegenResult;
  /** 每个组件各自的类代码产物。 */
  componentClasses: Array<{
    className: string;
    classCode: ClassComponentCodegenResult;
  }>;
}

/** 解析函数组件 TSX，并生成渲染计划与类代码。 */
export const compileFunctionComponentTsx = (
  fileName: string,
  source: string,
  options: CompilerPluginOptions = {}
): CompiledTsxFunctionComponent => {
  try {
    // 先把 TSX 源码压成统一 Program，再交给 compiler-core 继续做 lowering/codegen。
    const parsed = parseFunctionComponentTsx(fileName, source);
    const pipeline = runComponentCompilerPipeline(parsed.program, options);

    if (pipeline.components.length === 0) {
      throw new Error(
        'Compiler pipeline did not produce a component artifact.'
      );
    }

    // 一个文件可以声明多个组件，每个组件都会落成独立的类产物。
    // 开发态把 setup 输出成可重跑的方法，HMR 换实现时才能重建 setup 状态。
    const componentClasses = pipeline.components.map((artifact) => ({
      className: artifact.component.name,
      classCode: generateClassComponentCode(artifact.component, {
        hotReload: options.hotReload === true,
      }),
    }));
    const entryIndex = parsed.components.findIndex(
      (component) => component.name === parsed.component.name
    );
    const entryArtifact =
      pipeline.components[entryIndex] ?? pipeline.components[0]!;
    const entryClass = componentClasses[entryIndex] ?? componentClasses[0]!;

    return {
      className: parsed.component.name,
      classNames: componentClasses.map((entry) => entry.className),
      program: parsed.program,
      componentAst: parsed.component,
      ir: entryArtifact.component,
      staticHtml: entryArtifact.component.renderPlan.staticHtml,
      textBindings: entryArtifact.component.renderPlan.textBindings,
      renderCode: entryArtifact.renderCode,
      classCode: entryClass.classCode,
      componentClasses,
      ssrCode: entryClass.classCode.ssrCode,
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
  options: CompilerPluginOptions = {}
): string => {
  const compiled = compileFunctionComponentTsx(fileName, source, options);
  return emitFunctionComponentTsxModule(fileName, source, compiled).moduleCode;
};

/** 编译函数组件 TSX，并返回带 source map 的模块结果。 */
export const compileFunctionComponentTsxModule = (
  fileName: string,
  source: string,
  options: CompilerPluginOptions = {}
): CompiledTsxModule => {
  const compiled = emitFunctionComponentTsxModule(
    fileName,
    source,
    compileFunctionComponentTsx(fileName, source, options)
  );

  return {
    code: compiled.moduleCode,
    map: createCompiledTsxModuleMap(fileName, source, compiled.moduleCode),
    compiled,
  };
};
