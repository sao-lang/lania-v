/**
 * 增强组件（控制流/跨层能力）的轻量运行时实现。
 */

export {
  ENHANCED_COMPONENT_KIND,
  type AwaitProps,
  type CaseProps,
  type DynamicProps,
  type EachComponentDefinition,
  type EachProps,
  type DefaultProps,
  type ElseProps,
  type EnhancedComponentDefinition,
  type EnhancedComponentProps,
  type EnhancedRenderable,
  type ErrorBoundaryProps,
  type FragmentProps,
  type KeepAliveProps,
  type LazyLoadProps,
  type SlotProps,
  type SuspenseProps,
  type SwitchProps,
  type TeleportProps,
  type ThenProps,
  type TransitionGroupHookContext,
  type TransitionGroupLifecycleHook,
  type TransitionGroupProps,
  type TransitionHookContext,
  type TransitionLifecycleHook,
  type TransitionLifecycleHooks,
  type TransitionProps,
  type VirtualProps,
  type WhenMode,
  type WhenProps,
} from './types';
export { KeepAlive } from './keepalive';
export {
  Case,
  Default,
  Dynamic,
  Each,
  Else,
  Fragment,
  Slot,
  Switch,
  Teleport,
  Then,
  When,
} from './basic';
export { ErrorBoundary, LazyLoad, Suspense } from './async';
export { Await, Virtual } from './await-virtual';
export { Transition, TransitionGroup } from './transition';
export { isEnhancedDef } from './utils/predicates';

declare global {
  namespace JSX {
    interface ElementChildrenAttribute {
      children: {};
    }

    interface IntrinsicElements {
      When: import('./types').WhenProps;
      Then: import('./types').ThenProps;
      Else: import('./types').ElseProps;
      Switch: import('./types').SwitchProps;
      Case: import('./types').CaseProps;
      Default: import('./types').DefaultProps;
      Each: import('./types').EachProps<any>;
      Teleport: import('./types').TeleportProps;
      Fragment: import('./types').FragmentProps;
      Slot: import('./types').SlotProps;
      Dynamic: import('./types').DynamicProps;
      KeepAlive: import('./types').KeepAliveProps;
      Transition: import('./types').TransitionProps;
      TransitionGroup: import('./types').TransitionGroupProps;
      LazyLoad: import('./types').LazyLoadProps;
      ErrorBoundary: import('./types').ErrorBoundaryProps;
      Suspense: import('./types').SuspenseProps;
      Await: import('./types').AwaitProps<any>;
      Virtual: import('./types').VirtualProps<any>;
    }
  }
}
