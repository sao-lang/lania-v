/**
 * `@lania-v/runtime/advanced` 公共入口。
 *
 * 这里提供运行时的“增强能力”：控制流组件、异步边界、KeepAlive、Transition 等。
 * 它们依赖 runtime 的 host / slot / lifecycle 基础设施，因此 runtime 保持精简，
 * 需要这些组件时显式引入本包。
 */
export {
  Await,
  Case,
  Default,
  Dynamic,
  Each,
  Else,
  ErrorBoundary,
  Fragment,
  KeepAlive,
  LazyLoad,
  Match,
  Reach,
  Slot,
  Suspense,
  Switch,
  Teleport,
  Then,
  Transition,
  TransitionGroup,
  Virtual,
  When,
  isEnhancedDef,
} from './enhanced';
export { ENHANCED_COMPONENT_KIND } from './enhanced/types';

export type {
  AwaitProps,
  CaseProps,
  DefaultProps,
  DynamicProps,
  EachComponentDefinition,
  EachProps,
  ElseProps,
  EnhancedComponentDefinition,
  EnhancedComponentProps,
  EnhancedRenderable,
  ErrorBoundaryProps,
  FragmentProps,
  KeepAliveProps,
  LazyLoadProps,
  MatchProps,
  ReachProps,
  SlotProps,
  SuspenseProps,
  SwitchProps,
  TeleportProps,
  ThenProps,
  TransitionGroupHookContext,
  TransitionGroupLifecycleHook,
  TransitionGroupProps,
  TransitionHookContext,
  TransitionLifecycleHook,
  TransitionLifecycleHooks,
  TransitionProps,
  VirtualProps,
  VirtualScrollState,
  VirtualSize,
  VirtualHost,
  VirtualSizeInput,
  WhenMode,
  WhenProps,
} from './enhanced/types';

import { registerEnhancedConstructor } from '../dom/slots/dynamic-slot';
import {
  Await as AwaitComponent,
  Slot as SlotComponent,
  Transition as TransitionComponent,
  TransitionGroup as TransitionGroupComponent,
  Virtual as VirtualComponent,
} from './enhanced';

registerEnhancedConstructor('Slot', SlotComponent);
registerEnhancedConstructor('Transition', TransitionComponent);
registerEnhancedConstructor('TransitionGroup', TransitionGroupComponent);
registerEnhancedConstructor('Await', AwaitComponent);
registerEnhancedConstructor('Virtual', VirtualComponent);
