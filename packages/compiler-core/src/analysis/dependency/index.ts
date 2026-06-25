/**
 * 依赖分析。
 *
 * 负责从模板、computed、effect 与跨组件绑定中提取 signal 依赖，
 * 并整理出 slot/updater/深层路径读取等多种索引结构。
 */

export type * from './types';
export {
  analyzeBlockDependencies,
  analyzeExpressionDependencies,
} from './expression';
export { createEmptyDependencyAnalysis, analyzeComponentDependencies } from './component-analysis';
