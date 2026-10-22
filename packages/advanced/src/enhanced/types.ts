/**
 * 声明增强组件层暴露给运行时和用户代码的公共类型。
 *
 * 这里既包含 JSX 运行时可识别的渲染值，也包含 KeepAlive、Transition、Boundary
 * 等高阶组件的 props 契约，属于增强组件子系统的类型汇总入口。
 */
import {
  ENHANCED_COMPONENT_KIND,
  type BoundaryPayload,
  type CachePayload,
  type TransitionPayload,
} from '@lania-v/runtime';

import type { EnhancedRenderable } from '@lania-v/runtime';

export type { EnhancedRenderable };
import type { KeepAliveKeyPattern } from '@lania-v/runtime/component/lifecycle';

export type { KeepAliveKeyPattern };

export { ENHANCED_COMPONENT_KIND } from '@lania-v/runtime';

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
  /**
   * 行高来源，支持三态：
   * - `number`：固定行高，零测量成本，最快；
   * - `number[]`：逐项预知高度，避免首帧测量抖动；
   * - `(index) => number`：估算器，未测量行用估算值占位，渲染后以实测值覆盖。
   */
  itemHeight: number | readonly number[] | ((index: number) => number);
  /** 纵向可视区高度。 */
  height: number;
  /** 横向可视区宽度；必须同时提供 `itemWidth` 才会启用横向虚拟滚动。 */
  width?: number;
  /** 横向每项宽度，语义同 `itemHeight`。 */
  itemWidth?: number | readonly number[] | ((index: number) => number);
  overscan?: number;
  tag?: string;
  key?: (item: T, index: number) => PropertyKey;
  /** 列表为空时渲染；也接受 `() => renderable`。 */
  fallback?: EnhancedRenderable | (() => EnhancedRenderable);
  /** 返回分组名时该位置插入 sticky 分组头；返回空值表示不分组。 */
  groupBy?: (item: T, index: number) => string | null | undefined;
  /** 分组头渲染函数。 */
  header?: (group: string, index: number) => EnhancedRenderable;
  /** 分组头的行高，默认沿用 `itemHeight`。 */
  headerHeight?: number | readonly number[] | ((index: number) => number);
  /** 距底部小于该值时触发 `onEndReached`，默认 160。 */
  endReachedThreshold?: number;
  /** 是否还会追加数据；为 `true` 时允许反复触发 `onEndReached`。 */
  hasMore?: boolean;
  /** 行尺寸实测后回调，便于外部做布局联动。 */
  onResize?: (rowIndex: number, size: VirtualSize) => void;
  onEndReached?: () => void;
  /** 受控滚动位置：偏移数字或 `#index`。 */
  scrollTo?: number | `#${number}` | null;
  onScroll?: (state: VirtualScrollState) => void;
  /** children 必须是 `(item, index) => renderable`。 */
  children?: unknown;
}

export interface VirtualSize {
  height: number;
  width: number;
}

export interface VirtualScrollState {
  scrollTop: number;
  scrollLeft: number;
  /** 当前渲染窗口（含 overscan）的闭开区间。 */
  startIndex: number;
  endIndex: number;
  /** 滚动方向，便于做增量加载或埋点。 */
  direction: 'forward' | 'backward';
}

/** `Virtual` 渲染出的宿主节点额外暴露的命令式能力。 */
export interface VirtualHost extends HTMLElement {
  scrollToIndex(
    index: number,
    options?: { align?: 'start' | 'center' | 'end' }
  ): void;
  scrollToOffset(offset: number): void;
  /** 强制重测当前窗口内的行。 */
  measure(): void;
}

export type VirtualSizeInput =
  number | readonly number[] | ((index: number) => number);

export interface ReachProps extends EnhancedComponentProps {
  /** 触发回调。 */
  onReach?: () => void;
  /** `root`：盯滚动容器底部；`viewport`：盯哨兵自身进入视口。默认 `root`。 */
  mode?: 'root' | 'viewport';
  /** 滚动容器：CSS 选择器、元素，或 `null` 表示浏览器视口。省略时自动向上查找。 */
  root?: string | Element | null;
  /** 提前量，例如 `'240px'` 表示距底部 240px 就触发。仅 `root` 模式有效。 */
  rootMargin?: string;
  /** 交叉比例阈值，0~1。 */
  threshold?: number;
  /** 只触发一次。 */
  once?: boolean;
}
