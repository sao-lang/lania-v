/**
 * `@lania-v/runtime` 公共入口。
 *
 * 这里主要负责：
 * - 汇总导出各子模块（core/component/dom/reactivity/render）；
 * - 额外提供 reactivity/signal 的“顶层 re-export”，让用户 import 更顺手。
 */
export * from '@lania-v/shared';
export * from './core';
export * from './component';
export * from './dom/class-value';
export * from './dom/directives';
export * from './dom/html-value';
export * from './dom/ref';
export * from './dom/slot-pool';
export * from './dom/slot-table';
export {
  AttrSlot,
  BoundarySlot,
  ClassSlot,
  ComponentSlot,
  DirectiveBindingSlot,
  DynamicSlot,
  EventSlot,
  ForSlot,
  IfSlot,
  KeepAliveSlot,
  ModelBindingSlot,
  PropSlot,
  RefSlot,
  StyleObjectSlot,
  StyleSlot,
  TeleportSlot,
  TextSlot,
  UseDirectiveSlot,
  __resetKeepAliveSlotStateForTests,
  writeComponentProp,
} from './dom/slots';
export type { Slot as DomSlot, SlotFrequency, SlotType } from './dom/slots';
export * from './dom/style-value';
export * from './dom/updaters';
// 增强组件构造器注册表：runtime 的动态 slot 用它解析保留字符串，
// `@lania-v/advanced` 在加载时把真实构造器注册进来。
export { registerEnhancedConstructor } from './dom/slots/dynamic-slot';
export * from '@lania-v/reactivity';
// core 也导出同名调试入口与 `isDevEnvironment`，这里显式让 core 的实现优先，
// 避免两个包各自维护一份 dev 判定导致行为分叉。
export {
  emitSchedulerDebugEvent,
  emitSignalDebugEvent,
  isDevEnvironment,
  setDevEnvironmentOverride,
} from './core';
export * from './render';

// 增强组件（When/Each/KeepAlive/Transition...）已拆分到 @lania-v/advanced；
// runtime 只保留它们的公共类型契约，避免类型层断裂。
export type {
  EnhancedRenderable,
  EnhancedComponentDefinition,
} from './component/renderable-types';
export * from './dev/hmr';
export type {
  JsxElement,
  JsxProps,
  LaniaEnhancedIntrinsicElements,
  LaniaEventProps,
  LaniaIntrinsicElementProps,
  LaniaJsxElement,
  LaniaNativeIntrinsicElements,
} from './entry/jsx-runtime';
import {
  watch as reactiveWatch,
  type WatchCallback,
  type WatchOptions,
  type WatchSource,
  type WatchStopHandle,
} from '@lania-v/reactivity';
export {
  createComputedAccessor,
  createDeferred,
  createEffect,
  createMemo,
  createSignal,
  readonly,
  untrack,
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
} from '@lania-v/reactivity';
export function watch<T, Immediate extends boolean = false>(
  source: WatchSource<T>,
  callback: WatchCallback<T, Immediate>,
  options?: WatchOptions & { immediate?: Immediate },
  scheduler?: import('@lania-v/reactivity').Scheduler
): WatchStopHandle;
export function watch<
  T extends readonly unknown[],
  Immediate extends boolean = false,
>(
  sources: { [K in keyof T]: WatchSource<T[K]> },
  callback: WatchCallback<T, Immediate>,
  options?: WatchOptions & { immediate?: Immediate },
  scheduler?: import('@lania-v/reactivity').Scheduler
): WatchStopHandle;
export function watch(
  sourceOrSourceKey: WatchSource<unknown> | readonly WatchSource<unknown>[],
  callback:
    | ((current: unknown, previous: unknown | undefined) => void)
    | ((current: unknown[], previous: unknown[] | undefined) => void),
  options?: WatchOptions,
  scheduler?: import('@lania-v/reactivity').Scheduler
): WatchStopHandle {
  return reactiveWatch(
    sourceOrSourceKey as never,
    callback as never,
    options,
    scheduler
  );
}
