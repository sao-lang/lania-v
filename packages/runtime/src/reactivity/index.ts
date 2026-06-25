/**
 * 响应式子模块入口。
 *
 * - resource/store/scheduler：更偏“运行时设施”
 * - signal：用户最常用的 API（createSignal/createMemo/createEffect/watch...）
 */
export * from './resource';
export * from './scheduler';
export * from './store';
export {
  createDeferred,
  createEffect,
  createMemo,
  createSignal,
  readonly,
  untrack,
  watch,
  type DeferredOptions,
  type EffectCallback,
  type EffectCleanup,
  type ReadonlySignal,
  type Signal,
  type SignalSetter,
  type SignalSource,
  type WatchStopHandle,
} from './signal';
