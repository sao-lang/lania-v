/**
 * 响应式子模块入口。
 *
 * - resource/store/scheduler：更偏“运行时设施”
 * - signal：用户最常用的 API（createSignal/createMemo/createEffect/watch...）
 */
export * from './owner';
export * from './resource';
export * from './scheduler';
export * from './selector';
export * from './store';
export * from './transition';
export {
  createComputedAccessor,
  createDeferred,
  createEffect,
  createMemo,
  createSignal,
  readonly,
  untrack,
  watch,
  type ComputedAccessor,
  type DeferredOptions,
  type EffectCallback,
  type EffectCleanup,
  type ReadonlySignal,
  type Signal,
  type SignalSetter,
  type SignalSource,
  type WatchStopHandle,
} from './signal';
