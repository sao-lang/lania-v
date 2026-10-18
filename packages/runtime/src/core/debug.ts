import type { SchedulerPriority } from '../reactivity/scheduler';
import { __DEV__ } from './env';

/**
 * 运行时调试与插件系统。
 *
 * - debug hooks：给 devtools/测试环境订阅 scheduler/signal/lifecycle 事件；
 * - warning/assert：在 dev 环境输出更友好信息，并同时向 devtools 发事件；
 * - runtime plugin：允许通过 `useRuntimePlugin` 在运行时注入调试能力或扩展。
 *
 * 注意：多数 debug 事件在非 dev 环境会被短路，避免性能损耗。
 */

export interface SchedulerDebugEvent {
  type:
    | 'schedule'
    | 'schedule-lifecycle'
    | 'schedule-effect'
    | 'flush-start'
    | 'flush-end'
    | 'schedule-unit'
    | 'unit-run';
  priority?: SchedulerPriority;
  queueSize?: number;
}

export interface SignalDebugEvent {
  type: 'set';
  signalId: number;
  previous: unknown;
  current: unknown;
}

export interface LifecycleDebugEvent {
  type:
    | 'connected'
    | 'disconnected'
    | 'request-update'
    | 'will-update'
    | 'updated'
    | 'first-updated';
  component: object;
  tagName: string;
  changedKeys?: string[];
}

export interface DevtoolsEvent {
  type: string;
  payload?: unknown;
  timestamp: number;
}

export interface RuntimeDebugHooks {
  onSchedulerEvent?: (event: SchedulerDebugEvent) => void;
  onSignalEvent?: (event: SignalDebugEvent) => void;
  onLifecycleEvent?: (event: LifecycleDebugEvent) => void;
  onDevtoolsEvent?: (event: DevtoolsEvent) => void;
}

export interface RuntimePluginAPI {
  isDev: boolean;
  warning: (message: string, condition?: boolean) => boolean;
  assert: (condition: unknown, message: string) => asserts condition;
  registerDebugHooks: (hooks: RuntimeDebugHooks) => () => void;
  emitDevtoolsEvent: (type: string, payload?: unknown) => void;
}

export interface RuntimePlugin {
  name: string;
  setup: (api: RuntimePluginAPI) => void | (() => void);
}

let devEnvironmentOverride: boolean | null = null;
const runtimeDebugHooks = new Set<RuntimeDebugHooks>();
const runtimePluginCleanups = new Map<string, () => void>();

export const isDevEnvironment = (): boolean => {
  if (devEnvironmentOverride !== null) {
    return devEnvironmentOverride;
  }

  return __DEV__;
};

/**
 * 在打包时无法可靠注入 `__DEV__` 的场景下，允许手动覆盖 dev 判定。
 * - `index.dev.ts` 会强制设为 true
 * - `index.prod.ts` 会强制设为 false
 */
export const setDevEnvironmentOverride = (value: boolean | null): void => {
  devEnvironmentOverride = value;
};

export const emitDevtoolsEvent = (type: string, payload?: unknown): void => {
  // 没有订阅者时不构造事件对象，避免高频 updater/slot 路径产生无谓分配。
  if (runtimeDebugHooks.size === 0) {
    return;
  }

  const event: DevtoolsEvent = {
    type,
    payload,
    timestamp: Date.now(),
  };

  runtimeDebugHooks.forEach((hooks) => {
    hooks.onDevtoolsEvent?.(event);
  });
};

/** 是否存在 devtools 订阅者；热路径可据此跳过事件对象构造。 */
export const hasDevtoolsSubscribers = (): boolean => {
  return runtimeDebugHooks.size > 0;
};

export const warning = (message: string, condition = false): boolean => {
  if (condition) {
    return false;
  }

  if (isDevEnvironment()) {
    console.warn(`[lania-v] ${message}`);
  }

  emitDevtoolsEvent('warning', { message });
  return true;
};

export const assert = (condition: unknown, message: string): asserts condition => {
  if (condition) {
    return;
  }

  emitDevtoolsEvent('assert', { message });
  throw new Error(`[lania-v] ${message}`);
};

/** 注册一组 debug hooks；返回清理函数。 */
export const registerRuntimeDebugHooks = (hooks: RuntimeDebugHooks): (() => void) => {
  runtimeDebugHooks.add(hooks);

  return () => {
    runtimeDebugHooks.delete(hooks);
  };
};

export const clearRuntimeDebugHooks = (): void => {
  runtimeDebugHooks.clear();
};

export const emitSchedulerDebugEvent = (event: SchedulerDebugEvent): void => {
  if (!isDevEnvironment()) {
    return;
  }

  runtimeDebugHooks.forEach((hooks) => {
    hooks.onSchedulerEvent?.(event);
  });
};

export const emitSignalDebugEvent = (event: SignalDebugEvent): void => {
  if (!isDevEnvironment()) {
    return;
  }

  runtimeDebugHooks.forEach((hooks) => {
    hooks.onSignalEvent?.(event);
  });
};

export const emitLifecycleDebugEvent = (event: LifecycleDebugEvent): void => {
  if (!isDevEnvironment()) {
    return;
  }

  runtimeDebugHooks.forEach((hooks) => {
    hooks.onLifecycleEvent?.(event);
  });
};

export const useRuntimePlugin = (plugin: RuntimePlugin): (() => void) => {
  // 同名 plugin 再次安装时覆盖旧实例，保证幂等。
  runtimePluginCleanups.get(plugin.name)?.();

  const cleanup =
    plugin.setup({
      isDev: isDevEnvironment(),
      warning,
      assert,
      registerDebugHooks: registerRuntimeDebugHooks,
      emitDevtoolsEvent,
    }) ?? (() => undefined);

  runtimePluginCleanups.set(plugin.name, cleanup);

  return () => {
    runtimePluginCleanups.get(plugin.name)?.();
    runtimePluginCleanups.delete(plugin.name);
  };
};

export const clearRuntimePlugins = (): void => {
  runtimePluginCleanups.forEach((cleanup) => cleanup());
  runtimePluginCleanups.clear();
};
