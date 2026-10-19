import {
  ENHANCED_CONTRACT_PROTOCOL,
  ENHANCED_CONTRACT_VERSION,
  type BoundaryPayload,
  type BoundaryPayloadComponentName,
} from '@lania-v/shared';
import type {
  ErrorBoundaryHost,
  LazyBoundaryHost,
  SuspenseBoundaryHost,
} from './boundary-host';

/**
 * Boundary 运行时状态注册表。
 *
 * 这个文件集中维护三类增强边界能力在运行时共享的状态与工具函数：
 * 1. `LazyLoad`：观察可见性、缓存 observer/sentinel；
 * 2. `ErrorBoundary`：记录最近一次错误与 reset 行为；
 * 3. `Suspense`：记录当前 pending promise、已解析状态与重放时机。
 *
 * 它相当于增强边界的“小型状态中心”：
 * - 输入通常是编译器生成并注入到运行时的 boundary payload；
 * - 输出则是 host 层可以直接消费的 runtime options、state 和执行辅助函数。
 * 同时这里还承担两件很关键的职责：
 * - 把不可信 payload 先做协议级过滤，再交给具体边界逻辑消费；
 * - 让同一个 boundary key 在多次渲染/replay 之间复用同一份状态对象，避免状态散落在 host 侧。
 */

export interface LazyLoadState {
  visible: boolean;
  observer: IntersectionObserver | null;
  sentinel: HTMLSpanElement;
  observedTarget: Element | null;
  /**
   * 观察器创建后仍然存活，但 LazyLoad 实例可能已经重新挂载。
   * 这里保存“最近一次观察配置”，让共享 observer 始终回调当前实例的 replay / onVisibleChange。
   */
  activeOptions: {
    rootMargin?: string;
    once?: boolean;
    onVisibleChange?: (visible: boolean) => void;
  } | null;
}

export interface ErrorBoundaryState {
  error: unknown | null;
}

export type ErrorBoundaryFallback<TValue> =
  | TValue
  | ((error: unknown, reset: () => void) => TValue);

export interface SuspenseState {
  pending: Promise<unknown> | null;
  error: unknown | null;
}

const isPromiseLike = (value: unknown): value is Promise<unknown> => {
  return (
    typeof value === 'object' &&
    value !== null &&
    // 这里只做最小 duck-typing，兼容跨运行时或包装后的 thenable。
    typeof (value as { then?: unknown }).then === 'function'
  );
};

export type ResolvedLazyLoadRuntimeOptions = {
  payload: BoundaryPayload | null;
  key: string;
  rootMargin: string | undefined;
  once: boolean | undefined;
  observe: boolean | undefined;
};

export type ResolvedErrorBoundaryRuntimeOptions = {
  payload: BoundaryPayload | null;
  key: string;
};

export type ResolvedSuspenseRuntimeOptions = {
  payload: BoundaryPayload | null;
  key: string;
};

export type BoundaryRuntimeComponentName = BoundaryPayloadComponentName | null;

const lazyLoadStates = new Map<string, LazyLoadState>();
const errorBoundaryStates = new Map<string, ErrorBoundaryState>();
const suspenseStates = new Map<string, SuspenseState>();

// 测试场景下需要把全局状态表彻底清空，避免不同 case 之间互相污染。
export const __resetBoundaryStateForTests = (): void => {
  lazyLoadStates.forEach((state) => {
    state.observer?.disconnect();
    state.observer = null;
    state.observedTarget = null;
  });
  lazyLoadStates.clear();
  errorBoundaryStates.clear();
  suspenseStates.clear();
};

// 从不可信 payload 中读取并校验 boundary 协议。只有协议/version/component/irKind 全匹配才接受。
export const readBoundaryPayload = (
  payload: unknown,
  component: BoundaryPayloadComponentName
): BoundaryPayload | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const candidate = payload as Partial<BoundaryPayload>;
  if (
    candidate.protocol !== ENHANCED_CONTRACT_PROTOCOL ||
    candidate.version !== ENHANCED_CONTRACT_VERSION ||
    candidate.payloadKind !== 'boundary' ||
    candidate.component !== component ||
    candidate.irKind !== 'BoundaryIR'
  ) {
    // 任一协议字段不匹配都按“不是增强边界 payload”处理，避免后续运行时误信任结构。
    return null;
  }
  return candidate as BoundaryPayload;
};

// 只读取 payload 指向的边界组件种类，供运行时先做能力分派。
export const readBoundaryComponent = (
  payload: unknown
): BoundaryRuntimeComponentName => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const candidate = payload as Partial<BoundaryPayload>;
  if (
    candidate.protocol !== ENHANCED_CONTRACT_PROTOCOL ||
    candidate.version !== ENHANCED_CONTRACT_VERSION ||
    candidate.payloadKind !== 'boundary' ||
    candidate.irKind !== 'BoundaryIR'
  ) {
    return null;
  }
  const component = candidate.component;
  return component === 'LazyLoad' || component === 'ErrorBoundary' || component === 'Suspense'
    ? component
    : null;
};

// 从 payload.metadata 中按键读取额外配置字段。
const readBoundaryMeta = <TValue>(
  payload: BoundaryPayload | null,
  key: string
): TValue | undefined => {
  const metadata = payload?.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }
  const record = metadata as Record<string, unknown>;
  return record[key] as TValue | undefined;
};

// LazyLoad 运行时配置需要从 payload 中解出 key、rootMargin、observe、once 等字段。
export const resolveLazyOptions = (options: {
  payload: unknown;
}): ResolvedLazyLoadRuntimeOptions => {
  const payload = readBoundaryPayload(options.payload, 'LazyLoad');
  if (!payload) {
    throw new Error('LazyLoad runtime execution requires a shared boundary payload.');
  }
  const keySource = readBoundaryMeta<PropertyKey | null>(payload, 'lazyKey');
  return {
    payload,
    key: String(keySource ?? 'default'),
    rootMargin: readBoundaryMeta<string>(payload, 'rootMargin'),
    once: readBoundaryMeta<boolean>(payload, 'once'),
    observe: readBoundaryMeta<boolean>(payload, 'observe'),
  };
};

// ErrorBoundary 运行时配置相对简单，核心是稳定 key。
export const resolveErrorOptions = (options: {
  payload: unknown;
}): ResolvedErrorBoundaryRuntimeOptions => {
  const payload = readBoundaryPayload(options.payload, 'ErrorBoundary');
  if (!payload) {
    throw new Error('ErrorBoundary runtime execution requires a shared boundary payload.');
  }
  const keySource = readBoundaryMeta<PropertyKey | null>(payload, 'boundaryKey');
  return {
    payload,
    key: String(keySource ?? 'default'),
  };
};

// Suspense 同样需要稳定 key，这样同一边界多次 replay 时能复用同一状态对象。
export const resolveSuspenseOptions = (options: {
  payload: unknown;
}): ResolvedSuspenseRuntimeOptions => {
  const payload = readBoundaryPayload(options.payload, 'Suspense');
  if (!payload) {
    throw new Error('Suspense runtime execution requires a shared boundary payload.');
  }
  const keySource = readBoundaryMeta<PropertyKey | null>(payload, 'suspenseKey');
  return {
    payload,
    key: String(keySource ?? 'default'),
  };
};

// LazyLoad 状态是按 key 复用的；首次访问时会为 fallback 观察创建一个 sentinel。
export const getLazyLoadState = (key: string): LazyLoadState => {
  const existing = lazyLoadStates.get(key);
  if (existing) {
    return existing;
  }

  const sentinel = document.createElement('span');
  sentinel.setAttribute('aria-hidden', 'true');
  sentinel.dataset.laniaLazy = key;
  // sentinel 本身既能作为 fallback 锚点，也能在“尚无真实目标节点”时充当默认观察目标。
  sentinel.style.display = 'block';
  sentinel.style.width = '100%';
  sentinel.style.minHeight = '1px';

  const created: LazyLoadState = {
    visible: false,
    observer: null,
    sentinel,
    observedTarget: null,
    activeOptions: null,
  };
  lazyLoadStates.set(key, created);
  return created;
};

// 为 LazyLoad 绑定或更新 IntersectionObserver。
// `once` 模式下首次可见后会自动断开观察；持续观察模式则会在可见性变化时反复回调。
export const observeLazyTarget = (
  state: LazyLoadState,
  key: string,
  options: {
    rootMargin?: string;
    once?: boolean;
    onVisibleChange?: (visible: boolean) => void;
  },
  target: Element
): void => {
  if (typeof IntersectionObserver !== 'function') {
    return;
  }

  if (!state.observer) {
    state.observer = new IntersectionObserver(
      (entries) => {
        const isVisible = entries.some((entry) => entry.isIntersecting);
        // observer 会跨实例复用，回调必须读取当前实例登记的配置，
        // 否则重新挂载后的 LazyLoad 永远收不到 replay，界面会卡在 fallback。
        const active = state.activeOptions;

        if (active?.once) {
          if (isVisible && !state.visible) {
            state.visible = true;
            active.onVisibleChange?.(true);
            state.observer?.disconnect();
            state.observer = null;
          }
          return;
        }

        if (state.visible !== isVisible) {
          state.visible = isVisible;
          active?.onVisibleChange?.(isVisible);
        }
      },
      {
        rootMargin: options.rootMargin,
      }
    );
  }

  state.activeOptions = options;
  state.sentinel.dataset.laniaLazy = key;
  if (state.observedTarget && state.observedTarget !== target) {
    // 观察目标切换时先取消旧目标，避免同一 state 同时被多个元素竞争回调。
    state.observer?.unobserve(state.observedTarget);
  }
  state.observedTarget = target;
  state.observer.observe(target);
};

// LazyLoad 的统一执行流程：先按配置决定是否观察，再根据当前可见性返回 child 或 fallback。
export const runLazyLoad = <TValue>(options: {
  runtimeOptions: ResolvedLazyLoadRuntimeOptions;
  state: LazyLoadState;
  renderChild: () => TValue;
  renderFallback: (sentinel: HTMLSpanElement) => TValue;
  observeInvisibleTarget?: Element | null;
  observeVisibleTarget?: Element | null;
  observeWhileVisible?: boolean;
  onVisibleChange?: (visible: boolean) => void;
  onReplay?: () => void;
}): TValue => {
  const {
    runtimeOptions,
    state,
    renderChild,
    renderFallback,
    observeInvisibleTarget = state.sentinel,
    observeVisibleTarget = observeInvisibleTarget,
    observeWhileVisible = false,
    onVisibleChange,
    onReplay,
  } = options;

  if (runtimeOptions.observe === false) {
    return renderChild();
  }

  if (!state.visible || observeWhileVisible) {
    const target = state.visible ? observeVisibleTarget : observeInvisibleTarget;
    if (target) {
      observeLazyTarget(
        state,
        runtimeOptions.key,
        {
          rootMargin: runtimeOptions.rootMargin,
          once: runtimeOptions.once,
          onVisibleChange: (visible) => {
            onVisibleChange?.(visible);
            if (visible) {
              onReplay?.();
            }
          },
        },
        target
      );
    }
  }

  if (state.visible) {
    return renderChild();
  }

  return renderFallback(state.sentinel);
};

// 对外暴露给 LazyBoundaryHost 的执行入口。
export const executeLazyBoundary = <TValue>(options: {
  payload: unknown;
  host: LazyBoundaryHost<TValue>;
}): TValue => {
  const runtimeOptions = resolveLazyOptions(options);
  const state = getLazyLoadState(runtimeOptions.key);
  const { host } = options;
  const observeInvisibleTarget = host.observeInvisibleTarget ?? state.sentinel;
  const observeVisibleTarget = host.observeVisibleTarget ?? observeInvisibleTarget;
  return runLazyLoad({
    runtimeOptions,
    state,
    renderChild: () => host.renderChild(),
    renderFallback: (sentinel) => host.renderFallback(sentinel),
    observeInvisibleTarget,
    observeVisibleTarget,
    observeWhileVisible: host.observeWhileVisible,
    onVisibleChange: (visible) => {
      host.onVisibleChange?.(visible);
    },
    onReplay: () => {
      host.replay();
    },
  });
};

// ErrorBoundary/Error 状态按 key 复用，保证同一边界多次渲染期间错误态是可追踪的。
export const getErrorBoundaryState = (key: string): ErrorBoundaryState => {
  const existing = errorBoundaryStates.get(key);
  if (existing) {
    return existing;
  }

  const created: ErrorBoundaryState = {
    error: null,
  };
  errorBoundaryStates.set(key, created);
  return created;
};

export const hasErrorBoundaryError = (state: ErrorBoundaryState): boolean => {
  return state.error !== null;
};

export const readErrorBoundaryError = (
  state: ErrorBoundaryState
): unknown | null => {
  return state.error;
};

export const shouldRenderErrorBoundaryFallback = (
  state: ErrorBoundaryState
): boolean => {
  return readErrorBoundaryError(state) !== null;
};

// fallback 既支持静态值，也支持 `(error, reset) => ...` 形式的动态工厂。
export const resolveErrorBoundaryFallback = <TValue>(options: {
  error: unknown;
  fallback?: ErrorBoundaryFallback<TValue>;
  reset: () => void;
}): TValue | undefined => {
  const { error, fallback, reset } = options;
  return typeof fallback === 'function'
    ? (fallback as (error: unknown, reset: () => void) => TValue)(error, reset)
    : fallback;
};

// ErrorBoundary 的运行逻辑非常直接：有 error 就渲染 fallback；否则尝试渲染 child，异常时记录并切换。
export const runErrorBoundary = <TValue>(options: {
  state: ErrorBoundaryState;
  renderChild: () => TValue;
  renderFallback: (error: unknown) => TValue;
  onError?: (error: unknown) => void;
}): TValue => {
  const { state, renderChild, renderFallback, onError } = options;
  if (hasErrorBoundaryError(state)) {
    return renderFallback(readErrorBoundaryError(state));
  }

  try {
    return renderChild();
  } catch (error) {
    recordBoundaryError(state, error, {
      onError,
    });
    return renderFallback(error);
  }
};

// 对外暴露给 ErrorBoundaryHost 的执行入口，并把 reset 行为桥接回 host。
export const executeErrorBoundary = <TValue>(options: {
  payload: unknown;
  host: ErrorBoundaryHost<TValue>;
}): TValue => {
  const runtimeOptions = resolveErrorOptions(options);
  const state = getErrorBoundaryState(runtimeOptions.key);
  const { host } = options;
  const reset = () => {
    // 只有确实从 error 态复位成功时才触发 host.reset，避免无效重放。
    const didReset = resetErrorBoundaryError(state, {
      onReset: host.onReset,
    });
    if (didReset) {
      host.reset();
    }
  };

  return runErrorBoundary({
    state,
    renderChild: () => host.renderChild(),
    renderFallback: (error) => host.renderFallback(error, reset),
    onError: host.onError,
  });
};

// 记录错误时会同步触发可选的 onError 回调，供宿主上报日志或做副作用。
export const recordBoundaryError = (
  state: ErrorBoundaryState,
  error: unknown,
  handlers: {
    onError?: (error: unknown) => void;
  } = {}
): void => {
  state.error = error;
  handlers.onError?.(error);
};

// reset 成功时才返回 true，调用方可以据此决定是否触发 replay。
export const resetErrorBoundaryError = (
  state: ErrorBoundaryState,
  handlers: {
    onReset?: () => void;
  } = {}
): boolean => {
  if (state.error === null) {
    return false;
  }
  state.error = null;
  handlers.onReset?.();
  return true;
};

// Suspense 状态同时维护 `pending` 和 `error`，前者决定 fallback，后者决定是否重新抛出。
export const getSuspenseState = (key: string): SuspenseState => {
  const existing = suspenseStates.get(key);
  if (existing) {
    return existing;
  }

  const created: SuspenseState = {
    pending: null,
    error: null,
  };
  suspenseStates.set(key, created);
  return created;
};

// 注册新的 pending promise，并把 resolve/reject/replay 逻辑都挂在同一 promise 生命周期上。
export const registerSuspensePending = (
  state: SuspenseState,
  pending: Promise<unknown>,
  handlers: {
    onPending?: (promise: Promise<unknown>) => void;
    onResolve?: () => void;
    onReject?: (error: unknown) => void;
    onReplay?: () => void;
  } = {}
): boolean => {
  if (state.pending === pending) {
    return false;
  }

  state.pending = pending;
  handlers.onPending?.(pending);
  void pending.then(
    () => {
      if (state.pending === pending) {
        // 只消费“当前仍然有效”的 pending，避免旧 promise 竞态回写新状态。
        state.pending = null;
        state.error = null;
        handlers.onResolve?.();
        handlers.onReplay?.();
      }
    },
    (reason) => {
      if (state.pending === pending) {
        // reject 同样只回写当前 pending，避免旧请求失败覆盖新一轮 suspense 状态。
        state.pending = null;
        state.error = reason;
        handlers.onReject?.(reason);
        handlers.onReplay?.();
      }
    }
  );
  return true;
};

// Suspense 执行规则：
// 1. 有 error 就继续抛出；
// 2. 有 pending 就直接渲染 fallback；
// 3. 首次渲染 child 时若抛出 Promise，则转入 pending 并回退到 fallback。
export const runSuspense = <TValue>(options: {
  state: SuspenseState;
  renderChild: () => TValue;
  renderFallback: () => TValue;
  onPending?: (promise: Promise<unknown>) => void;
  onResolve?: () => void;
  onReject?: (error: unknown) => void;
  onReplay?: () => void;
  onNonPromiseError?: (error: unknown) => TValue;
}): TValue => {
  const {
    state,
    renderChild,
    renderFallback,
    onPending,
    onResolve,
    onReject,
    onReplay,
    onNonPromiseError,
  } = options;

  if (state.error !== null) {
    throw state.error;
  }

  if (state.pending) {
    return renderFallback();
  }

  try {
    const value = renderChild();
    state.pending = null;
    return value;
  } catch (error) {
    if (!isPromiseLike(error)) {
      if (onNonPromiseError) {
        return onNonPromiseError(error);
      }
      throw error;
    }

    registerSuspensePending(state, error, {
      onPending,
      onResolve,
      onReject,
      onReplay,
    });
    return renderFallback();
  }
};

// 对外暴露给 SuspenseBoundaryHost 的执行入口。
export const executeSuspenseBoundary = <TValue>(options: {
  payload: unknown;
  host: SuspenseBoundaryHost<TValue>;
}): TValue => {
  const runtimeOptions = resolveSuspenseOptions(options);
  const state = getSuspenseState(runtimeOptions.key);
  const { host } = options;
  return runSuspense({
    state,
    renderChild: () => host.renderChild(),
    renderFallback: () => host.renderFallback(),
    onPending: host.onPending,
    onResolve: host.onResolve,
    onReject: host.onReject,
    onReplay: () => {
      host.replay();
    },
    onNonPromiseError: host.onNonPromiseError,
  });
};
