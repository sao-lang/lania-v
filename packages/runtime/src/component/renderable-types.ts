import { ENHANCED_COMPONENT_KIND } from './enhanced-marker';
import type {
  BoundaryPayload,
  CachePayload,
  TransitionPayload,
} from '@lania-v/shared';

export { ENHANCED_COMPONENT_KIND };

export type KeepAliveKeyPattern = readonly string[] | RegExp | null | undefined;

/**
 * 增强组件的公共类型契约。
 *
 * 这些类型描述的是「渲染值形态 + props 契约」，不包含任何运行时代码，
 * 因此由 runtime 提供，`@lania-v/runtime/advanced` 与 JSX 运行时共同复用。
 */
// 统一描述增强组件允许返回的渲染值，后续兼容层会继续展开函数和数组。
export type EnhancedRenderable =
  | Node
  | string
  | number
  | boolean
  | null
  | undefined
  | (() => EnhancedRenderable)
  | readonly EnhancedRenderable[];

// 所有增强组件定义都会打上运行时标记，便于在 JSX 阶段识别。
export interface EnhancedComponentDefinition<
  TName extends string,
  TProps extends object,
  TResult = unknown,
> {
  (props: TProps): TResult;
  readonly displayName: TName;
  readonly [ENHANCED_COMPONENT_KIND]: true;
}

export interface EachComponentDefinition<TResult = unknown> {
  <T>(props: EachProps<T>): TResult;
  readonly displayName: 'Each';
  readonly [ENHANCED_COMPONENT_KIND]: true;
}

export interface EnhancedComponentProps {
  children?: unknown;
}

export type WhenMode = 'retain' | 'remount';

export interface WhenProps extends EnhancedComponentProps {
  value: boolean;
  fallback?: EnhancedRenderable;
  mode?: WhenMode;
}

export interface ThenProps extends EnhancedComponentProps {}

export interface ElseProps extends EnhancedComponentProps {}

export interface SwitchProps extends EnhancedComponentProps {
  /** 提供时进入取值匹配模式，`<Case when>` 与它做严格相等比较。 */
  value?: unknown;
  mode?: WhenMode;
}

export interface CaseProps extends EnhancedComponentProps {
  /** 取值匹配模式下的期望值；没有 `Switch value` 时按布尔条件处理。 */
  when?: unknown;
}

export interface MatchProps extends EnhancedComponentProps {
  /** 布尔分支条件。 */
  value: unknown;
}

export interface DefaultProps extends EnhancedComponentProps {}

export interface EachProps<T> extends EnhancedComponentProps {
  value: readonly T[] | null | undefined;
  key?: (item: T, index: number) => PropertyKey;
  fallback?: EnhancedRenderable;
  children:
    ((item: T, index: number) => EnhancedRenderable) | EnhancedRenderable;
}

export interface TeleportProps extends EnhancedComponentProps {
  to: string | Element | null | undefined;
}

export interface FragmentProps extends EnhancedComponentProps {}

export interface SlotProps extends EnhancedComponentProps {
  name?: string;
  fallback?: EnhancedRenderable;
  /** 传给函数型 slot 的参数；数组会按位置展开。 */
  props?: unknown;
}

export interface DynamicProps extends EnhancedComponentProps {
  is?: unknown;
  component?: unknown;
  props?: Record<string, unknown>;
  fallback?: EnhancedRenderable;
}

// KeepAlive 相关 props 会传给共享缓存运行时，用于命中、淘汰与生命周期回调。
export interface KeepAliveProps extends EnhancedComponentProps {
  payload?: CachePayload;
  scope?: string;
  cacheKey?: PropertyKey | null;
  include?: KeepAliveKeyPattern;
  exclude?: KeepAliveKeyPattern;
  max?: number;
  onActivate?: (
    value: EnhancedRenderable,
    key: string,
    reused: boolean
  ) => void;
  onDeactivate?: (value: EnhancedRenderable, key: string) => void;
  onCache?: (value: EnhancedRenderable, key: string) => void;
  onEvict?: (value: EnhancedRenderable, key: string) => void;
}

// Transition 与 TransitionGroup 共用阶段上下文，只是 group 额外携带 key/index。
export interface TransitionHookContext {
  name?: string;
  phase: 'enter' | 'leave' | 'appear' | 'move';
}

export interface TransitionGroupHookContext extends TransitionHookContext {
  key: PropertyKey;
  index: number;
  previousIndex?: number;
}

export type TransitionLifecycleHook = (
  element: Element,
  context: TransitionHookContext
) => void | Promise<void>;

export type TransitionGroupLifecycleHook = (
  element: Element,
  context: TransitionGroupHookContext
) => void | Promise<void>;

export interface TransitionLifecycleHooks {
  enter?: TransitionLifecycleHook;
  leave?: TransitionLifecycleHook;
  appear?: TransitionLifecycleHook;
  onEnter?: TransitionLifecycleHook;
  onLeave?: TransitionLifecycleHook;
  onAppear?: TransitionLifecycleHook;
}

export interface TransitionProps extends EnhancedComponentProps {
  payload?: TransitionPayload;
  name?: string;
  transitionKey?: PropertyKey | null;
  enter?: TransitionLifecycleHook;
  leave?: TransitionLifecycleHook;
  appear?: TransitionLifecycleHook;
  onEnter?: TransitionLifecycleHook;
  onLeave?: TransitionLifecycleHook;
  onAppear?: TransitionLifecycleHook;
}

export interface TransitionGroupProps extends EnhancedComponentProps {
  payload?: TransitionPayload;
  name?: string;
  tag?: string;
  groupKey?: PropertyKey | null;
  keys?: readonly PropertyKey[];
  move?: TransitionGroupLifecycleHook;
  leave?: TransitionGroupLifecycleHook;
  enter?: TransitionGroupLifecycleHook;
  appear?: TransitionGroupLifecycleHook;
  onMove?: TransitionGroupLifecycleHook;
  onLeave?: TransitionGroupLifecycleHook;
  onEnter?: TransitionGroupLifecycleHook;
  onAppear?: TransitionGroupLifecycleHook;
}

// Boundary 系组件通过 payload 把编译期约定的共享元数据带进运行时。
export interface LazyLoadProps extends EnhancedComponentProps {
  fallback?: EnhancedRenderable;
  target?: Element | null;
  onVisibleChange?: (visible: boolean) => void;
  payload?: BoundaryPayload;
  lazyKey?: PropertyKey | null;
  rootMargin?: string;
  once?: boolean;
  observe?: boolean;
}

export interface ErrorBoundaryProps extends EnhancedComponentProps {
  fallback?:
    | EnhancedRenderable
    | ((error: unknown, reset: () => void) => EnhancedRenderable);
  onError?: (error: unknown) => void;
  onReset?: () => void;
  payload?: BoundaryPayload;
  boundaryKey?: PropertyKey | null;
}

export interface SuspenseProps extends EnhancedComponentProps {
  fallback?: EnhancedRenderable;
  onPending?: (promise: Promise<unknown>) => void;
  onResolve?: () => void;
  onReject?: (error: unknown) => void;
  payload?: BoundaryPayload;
  suspenseKey?: PropertyKey | null;
}

export interface AwaitProps<T = unknown> extends EnhancedComponentProps {
  value: Promise<T> | (() => Promise<T> | T) | T;
  fallback?: EnhancedRenderable | (() => EnhancedRenderable);
  error?: EnhancedRenderable | ((error: unknown) => EnhancedRenderable);
  delay?: number;
  onResolve?: (value: T) => void;
  onReject?: (error: unknown) => void;
}

export interface VirtualProps<T = unknown> extends EnhancedComponentProps {
  value: readonly T[];
  itemHeight: number;
  height: number;
  overscan?: number;
  tag?: string;
  key?: (item: T, index: number) => PropertyKey;
  onScroll?: (scrollTop: number) => void;
  /** children 必须是 `(item, index) => renderable`。 */
  children?: unknown;
}
