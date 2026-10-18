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
export * from './reactivity/resource';
export * from './reactivity/scheduler';
export * from './reactivity/store';
export * from './render';
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
  type SignalSource,
  type WatchStopHandle,
} from './reactivity/signal';
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
  type WatchStopHandle,
} from './reactivity/signal';
export function watch<T>(
  source: SignalSource<T>,
  callback: (current: T, previous: T) => void,
  scheduler?: import('./reactivity/scheduler').Scheduler
): WatchStopHandle;
export function watch<T extends readonly unknown[]>(
  sources: { [K in keyof T]: SignalSource<T[K]> },
  callback: (current: T, previous: T) => void,
  scheduler?: import('./reactivity/scheduler').Scheduler
): WatchStopHandle;
export function watch(
  sourceOrSourceKey: SignalSource<unknown> | readonly SignalSource<unknown>[],
  callback: ((current: unknown, previous: unknown) => void) | import('./reactivity/scheduler').Scheduler,
  scheduler?: import('./reactivity/scheduler').Scheduler
): WatchStopHandle {
  return reactiveWatch(sourceOrSourceKey as never, callback as never, scheduler);
}
