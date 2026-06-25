/**
 * 定义 Boundary 系组件与外层运行时之间的宿主协议。
 *
 * Lazy、ErrorBoundary、Suspense 都基于基础 BoundaryHost 扩展出各自的渲染与回调契约。
 */
import { getCurrentRuntimeScope } from '../host/function-component';

// 基础宿主只需要支持请求更新、重放和重置三个动作。
export interface BoundaryHost {
  requestUpdate(): void;
  replay(): void;
  reset(): void;
}

export interface LazyBoundaryHost<TValue> extends BoundaryHost {
  renderChild(): TValue;
  renderFallback(sentinel: HTMLSpanElement): TValue;
  onVisibleChange?: (visible: boolean) => void;
  observeInvisibleTarget?: Element | null;
  observeVisibleTarget?: Element | null;
  observeWhileVisible?: boolean;
}

export interface ErrorBoundaryHost<TValue> extends BoundaryHost {
  renderChild(): TValue;
  renderFallback(error: unknown, reset: () => void): TValue;
  onError?: (error: unknown) => void;
  onReset?: () => void;
}

export interface SuspenseBoundaryHost<TValue> extends BoundaryHost {
  renderChild(): TValue;
  renderFallback(): TValue;
  onPending?: (promise: Promise<unknown>) => void;
  onResolve?: () => void;
  onReject?: (error: unknown) => void;
  onNonPromiseError?: (error: unknown) => TValue;
}

export type BoundaryContextHost = {
  requestUpdate?: () => void;
};

const noop = (): void => {};

// 缺省情况下 replay/reset 会层层退回到 requestUpdate，降低接入成本。
export const createBoundaryHost = (
  handlers: Partial<BoundaryHost> = {}
): BoundaryHost => {
  const requestUpdate = handlers.requestUpdate ?? noop;
  const replay = handlers.replay ?? requestUpdate;
  const reset = handlers.reset ?? replay;

  return {
    requestUpdate,
    replay,
    reset,
  };
};

export const createLazyBoundaryHost = <TValue>(options: {
  boundary?: Partial<BoundaryHost>;
  renderChild: () => TValue;
  renderFallback: (sentinel: HTMLSpanElement) => TValue;
  onVisibleChange?: (visible: boolean) => void;
  observeInvisibleTarget?: Element | null;
  observeVisibleTarget?: Element | null;
  observeWhileVisible?: boolean;
}): LazyBoundaryHost<TValue> => {
  const boundary = createBoundaryHost(options.boundary);
  return {
    ...boundary,
    renderChild: options.renderChild,
    renderFallback: options.renderFallback,
    onVisibleChange: options.onVisibleChange,
    observeInvisibleTarget: options.observeInvisibleTarget,
    observeVisibleTarget: options.observeVisibleTarget,
    observeWhileVisible: options.observeWhileVisible,
  };
};

export const createErrorBoundaryHost = <TValue>(options: {
  boundary?: Partial<BoundaryHost>;
  renderChild: () => TValue;
  renderFallback: (error: unknown, reset: () => void) => TValue;
  onError?: (error: unknown) => void;
  onReset?: () => void;
}): ErrorBoundaryHost<TValue> => {
  const boundary = createBoundaryHost(options.boundary);
  return {
    ...boundary,
    renderChild: options.renderChild,
    renderFallback: options.renderFallback,
    onError: options.onError,
    onReset: options.onReset,
  };
};

export const createSuspenseBoundaryHost = <TValue>(options: {
  boundary?: Partial<BoundaryHost>;
  renderChild: () => TValue;
  renderFallback: () => TValue;
  onPending?: (promise: Promise<unknown>) => void;
  onResolve?: () => void;
  onReject?: (error: unknown) => void;
  onNonPromiseError?: (error: unknown) => TValue;
}): SuspenseBoundaryHost<TValue> => {
  const boundary = createBoundaryHost(options.boundary);
  return {
    ...boundary,
    renderChild: options.renderChild,
    renderFallback: options.renderFallback,
    onPending: options.onPending,
    onResolve: options.onResolve,
    onReject: options.onReject,
    onNonPromiseError: options.onNonPromiseError,
  };
};

// 从当前运行时作用域中读出上层宿主，仅暴露 requestUpdate 给 boundary 复用。
export const readContextBoundaryHost = (): BoundaryHost => {
  const host = getCurrentRuntimeScope()?.host as BoundaryContextHost | undefined;

  return createBoundaryHost({
    requestUpdate: () => {
      host?.requestUpdate?.();
    },
  });
};
