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
// atom 本身是 Signal 形态（`value` getter + `updaters`），这里只做结构校验，
// 因此不需要反向依赖 `@lania-v/store`。
export const getAtomDependency = (
  atom: unknown
): { readonly value: unknown; updaters: Set<() => void> } => {
  if (
    atom === null ||
    (typeof atom !== 'object' && typeof atom !== 'function') ||
    !('updaters' in (atom as object))
  ) {
    throw new TypeError(
      'getAtomDependency() expects an atom created by @lania-v/store.'
    );
  }

  return atom as { readonly value: unknown; updaters: Set<() => void> };
};
