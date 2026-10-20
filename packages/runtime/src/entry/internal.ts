/**
 * 汇总运行时内部入口。
 *
 * 这些导出主要供编译器产物或高级集成层访问，不面向普通业务层直接使用。
 */
export type {
  BoundaryContextHost,
  BoundaryHost,
  ErrorBoundaryHost,
  LazyBoundaryHost,
  SuspenseBoundaryHost,
} from '../component/lifecycle/boundary-host';
export {
  createBoundaryHost,
  createErrorBoundaryHost,
  createLazyBoundaryHost,
  createSuspenseBoundaryHost,
  readContextBoundaryHost,
} from '../component/lifecycle/boundary-host';
export type {
  DomHostBlockRecord,
  DomHostOwner,
  DomHostRemovedBlockHandoff,
  DomHostTarget,
  RuntimeScope,
  RuntimeScopeHost,
} from '../component/host/function-component';
export {
  DOM_HOST_SYMBOL,
  getCurrentDomHostTarget,
  getCurrentRuntimeScope,
  getDomHostRedirect,
  registerDomHostRedirect,
  withComponentProps,
  withContextHost,
  withRuntimeScope,
  withDomHost,
} from '../component/host/function-component';

// 编译器产物用它把 atom 的精确订阅直接挂到 updater 的 deps 上。
// atom 本身就是 Signal 形态，实现位于 `@lania/store` 的内部入口。
export { getAtomDependency } from '@lania/store/internal';
