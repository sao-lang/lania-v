/**
 * Transition 子模块公共入口。
 *
 * 增强组件（`@lania-v/runtime/advanced`）需要复用 transition 的宿主渲染与注册表能力，
 * 这里把这些运行时设施集中导出，避免跨包依赖深层文件路径。
 */
export * from './group-registry';
export * from './host';
export * from './host-hooks';
export * from './host-runtime';
export * from './host-types';
export * from './registry';
export * from './runtime';
