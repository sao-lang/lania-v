/**
 * `@lania-v/runtime` 公共入口。
 *
 * 这里主要负责汇总导出 core/component/dom/render 等基础能力。
 *
 * 响应式 API（Signal/Effect/Computed/...）与增强组件位于二级入口：
 * - `@lania-v/runtime/reactivity`
 * - `@lania-v/runtime/advanced`
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
// `@lania-v/runtime/advanced` 在加载时把真实构造器注册进来。
export { registerEnhancedConstructor } from './dom/slots/dynamic-slot';
// core 也导出同名调试入口与 `isDevEnvironment`，这里显式让 core 的实现优先，
// 避免两个包各自维护一份 dev 判定导致行为分叉。
export {
  emitSchedulerDebugEvent,
  emitSignalDebugEvent,
  isDevEnvironment,
  setDevEnvironmentOverride,
} from './core';
export * from './render';

// 增强组件（When/Each/KeepAlive/Transition...）已拆分到 @lania-v/runtime/advanced；
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
