import type { CompilerProgram } from '../ast';
import type { ComponentIR } from '../ir/component';
import type { ComponentCompilationArtifact } from './index';

/**
 * 编译管线插件接口。
 *
 * 这一层只描述“什么时候能插手”，不描述“如何实现插件”。
 * 设计目标是把插件能力对齐到主管线的几个稳定阶段：
 * - `transformProgram` 面向整份 AST，适合做全局扫描或预处理。
 * - `transformTemplate` 面向单组件 IR，适合做模板结构改写。
 * - `beforeAnalyzeComponent` / `afterAnalyzeComponent` 则围绕依赖分析前后，
 *   方便插件读取或补充分析信息。
 * - `afterGenerateArtifact` 用于最终产物收尾，比如注入额外代码或采集统计信息。
 *
 * 这样做的核心收益是：插件只依赖阶段边界，不必依赖某个私有 helper 的内部实现。
 */
export interface CompilerPlugin {
  name: string;
  transformProgram?: (program: CompilerProgram) => void;
  transformTemplate?: (component: ComponentIR) => void;
  beforeAnalyzeComponent?: (component: ComponentIR) => void;
  afterAnalyzeComponent?: (component: ComponentIR) => void;
  afterGenerateArtifact?: (artifact: ComponentCompilationArtifact) => void;
}

/** 插件配置项。 */
export interface CompilerPluginOptions {
  plugins?: CompilerPlugin[];
}

/** 运行程序级别的预处理钩子。 */
export const applyProgramPlugins = (
  program: CompilerProgram,
  plugins: readonly CompilerPlugin[] = []
): void => {
  plugins.forEach((plugin) => {
    plugin.transformProgram?.(program);
  });
};

/** 运行模板转换钩子。 */
export const applyTemplateTransformPlugins = (
  component: ComponentIR,
  plugins: readonly CompilerPlugin[] = []
): void => {
  plugins.forEach((plugin) => {
    plugin.transformTemplate?.(component);
  });
};

/** 运行分析前钩子。 */
export const applyBeforeAnalyzePlugins = (
  component: ComponentIR,
  plugins: readonly CompilerPlugin[] = []
): void => {
  plugins.forEach((plugin) => {
    plugin.beforeAnalyzeComponent?.(component);
  });
};

/** 运行分析后钩子。 */
export const applyAfterAnalyzePlugins = (
  component: ComponentIR,
  plugins: readonly CompilerPlugin[] = []
): void => {
  plugins.forEach((plugin) => {
    plugin.afterAnalyzeComponent?.(component);
  });
};

/** 运行产物生成后的钩子。 */
export const applyArtifactPlugins = (
  artifact: ComponentCompilationArtifact,
  plugins: readonly CompilerPlugin[] = []
): void => {
  plugins.forEach((plugin) => {
    plugin.afterGenerateArtifact?.(artifact);
  });
};
