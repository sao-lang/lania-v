/**
 * `@lania-v/reactivity` 公共入口。
 *
 * 响应式核心独立成包，不依赖框架运行时：
 * - `owner` / `scheduler`：作用域清理与调度基础设施；
 * - `signal` / `resource` / `selector` / `transition`：用户常用 API；
 * - `debug`：dev 判定与调试事件通道，供框架运行时接入。
 */
export * from './debug';
export * from './owner';
export * from './resource';
export * from './scheduler';
export * from './selector';
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
  type WatchCallback,
  type WatchOptions,
  type WatchSource,
  type WatchStopHandle,
} from './signal';
