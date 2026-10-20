/**
 * 增强组件运行时值的归一化与节点提取工具。
 *
 * 这层逻辑同时被 runtime（host / slot）与增强组件消费，因此实现留在 runtime 公共入口，
 * 这里只做再导出，避免两份实现产生行为漂移。
 */
export {
  appendRenderable,
  asRenderable,
  collectRenderableNodes,
  createValueFromNodes,
  getRenderableElements,
  hasRenderableContent,
  invokeRenderable,
  resolveRenderableIdentity,
  toRenderableArray,
} from '@lania-v/runtime';
export type { EnhancedRenderable } from '../types';
