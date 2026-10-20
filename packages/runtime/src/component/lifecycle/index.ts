/**
 * 生命周期子模块公共入口。
 *
 * 增强组件需要复用边界（Boundary）与 KeepAlive 注册表，这里集中导出，
 * 使 `@lania-v/advanced` 不必依赖 runtime 的内部文件布局。
 */
export * from './boundary-host';
export * from './boundary-registry';
export * from './keepalive-registry';
