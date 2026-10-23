/**
 * 开发环境判定与调试事件通道。
 *
 * 响应式核心需要独立于框架运行时存在：
 * - `isDevEnvironment()` 优先读取构建期注入的 `__LANIA_DEV__`，其次读取 `NODE_ENV`；
 * - `@lania-v/runtime` 会用 `setDevEnvironmentOverride()` 把自己的 dev/prod 入口设置同步过来，
 *   因此调试开关仍然可以在应用入口统一控制。
 */
declare const __LANIA_DEV__: boolean | undefined;

const detectDevEnvironment = (): boolean => {
  if (typeof __LANIA_DEV__ === 'boolean') {
    return __LANIA_DEV__;
  }

  const nodeEnv =
    typeof process === 'undefined' ? undefined : process.env.NODE_ENV;

  return nodeEnv !== 'production';
};

let devEnvironmentOverride: boolean | null = null;

export const isDevEnvironment = (): boolean => {
  return devEnvironmentOverride ?? detectDevEnvironment();
};

/**
 * 在打包时无法可靠注入 `__LANIA_DEV__` 的场景下，允许手动覆盖 dev 判定。
 * runtime 的 `index.dev.ts` / `index.prod.ts` 会调用它保持全链路一致。
 */
export const setDevEnvironmentOverride = (value: boolean | null): void => {
  devEnvironmentOverride = value;
};

export interface PrimitiveSchedulerDebugEvent {
  type:
    | 'schedule'
    | 'schedule-lifecycle'
    | 'schedule-effect'
    | 'flush-start'
    | 'flush-end'
    | 'schedule-unit'
    | 'unit-run';
  priority?: string;
  queueSize?: number;
}

export interface PrimitiveSignalDebugEvent {
  type: 'set';
  signalId: number;
  previous: unknown;
  current: unknown;
}

export interface PrimitiveDebugHooks {
  onSchedulerEvent?: (event: PrimitiveSchedulerDebugEvent) => void;
  onSignalEvent?: (event: PrimitiveSignalDebugEvent) => void;
}

const debugHooks = new Set<PrimitiveDebugHooks>();

/** 订阅响应式核心的调试事件；返回取消订阅函数。 */
export const addPrimitiveDebugHooks = (
  hooks: PrimitiveDebugHooks
): (() => void) => {
  debugHooks.add(hooks);
  return () => {
    debugHooks.delete(hooks);
  };
};

export const emitSchedulerDebugEvent = (
  event: PrimitiveSchedulerDebugEvent
): void => {
  if (!isDevEnvironment()) {
    return;
  }

  for (const hooks of debugHooks) {
    hooks.onSchedulerEvent?.(event);
  }
};

export const emitSignalDebugEvent = (
  event: PrimitiveSignalDebugEvent
): void => {
  if (!isDevEnvironment()) {
    return;
  }

  for (const hooks of debugHooks) {
    hooks.onSignalEvent?.(event);
  }
};
