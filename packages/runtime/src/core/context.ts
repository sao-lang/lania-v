/**
 * 基于事件冒泡的 Context 实现（不依赖框架运行时全局）。
 *
 * - `provideContext` 在某个 host 上监听 context-request 事件并拦截/resolve；
 * - `provideContextHere` 是函数组件编译期语法糖，会被改写成 `provideContext(this, ...)`；
 * - `consumeContext` 通过派发事件向上冒泡寻找最近的 provider；
 * - 适用于 Custom Element 与函数组件混用的场景（只要能 dispatchEvent）。
 */

import { createSignal, readonly, type ReadonlySignal } from '../reactivity/signal';

export interface Context<T> {
  readonly id: symbol;
  // 默认值也包装成只读 signal，这样 consumer 侧始终拿到统一的 SignalSource<T> 语义。
  readonly defaultValue: ReadonlySignal<T>;
  readonly description?: string;
}

export type ContextValueProvider<T> = T | ReadonlySignal<T> | (() => T);

interface ContextRequestDetail<T> {
  context: Context<T>;
  resolve(value: ReadonlySignal<T>): void;
}

const CONTEXT_REQUEST_EVENT = 'lania:context-request';

const isSignalLike = <T>(value: unknown): value is ReadonlySignal<T> => {
  return typeof value === 'function' && value !== null && 'updaters' in (value as object);
};

const toReadonlySignal = <T>(value: ContextValueProvider<T>): ReadonlySignal<T> => {
  if (isSignalLike<T>(value)) {
    return value;
  }
  if (typeof value === 'function') {
    // 兼容旧 API：`() => T` 会被当作“初始化时求值一次”的常量源，
    // 若需要真正响应式联动，应显式传入 signal / memo。
    return readonly(createSignal((value as () => T)()));
  }
  return readonly(createSignal(value));
};

export const createContext = <T>(
  defaultValue: T,
  description?: string
): Context<T> => {
  return {
    id: Symbol(description ?? 'lania-context'),
    defaultValue: readonly(createSignal(defaultValue)),
    description,
  };
};

export const provideContext = <T>(
  host: EventTarget,
  context: Context<T>,
  value: ContextValueProvider<T>
): (() => void) => {
  const provided = toReadonlySignal(value);
  const handler = (event: Event) => {
    const customEvent = event as CustomEvent<ContextRequestDetail<T>>;

    if (customEvent.detail.context.id !== context.id) {
      return;
    }

    // 找到匹配 provider 后阻止继续向上冒泡，保证“最近的 provider”生效。
    customEvent.stopPropagation();
    customEvent.detail.resolve(provided);
  };

  host.addEventListener(CONTEXT_REQUEST_EVENT, handler as EventListener);

  return () => {
    host.removeEventListener(CONTEXT_REQUEST_EVENT, handler as EventListener);
  };
};

export const provideContextHere = <T>(
  _context: Context<T>,
  _value: ContextValueProvider<T>
): never => {
  throw new Error(
    'provideContextHere() is compile-time only. It must be rewritten to provideContext(this, context, value).'
  );
};

export const consumeContext = <T>(
  host: { dispatchEvent(event: Event): boolean },
  context: Context<T>
): ReadonlySignal<T> => {
  let resolvedValue = context.defaultValue;

  const event = new CustomEvent<ContextRequestDetail<T>>(CONTEXT_REQUEST_EVENT, {
    bubbles: true,
    composed: true,
    cancelable: true,
    detail: {
      context,
      resolve(value) {
        resolvedValue = value;
      },
    },
  });

  host.dispatchEvent(event);
  return resolvedValue;
};

// Convenience for code that just needs an immediate snapshot.
export const consumeContextValue = <T>(
  host: { dispatchEvent(event: Event): boolean },
  context: Context<T>
): T => {
  // 这是面向“只要当前快照值”的便捷函数；若要继续订阅变化，应使用 consumeContext。
  return consumeContext(host, context)();
};
