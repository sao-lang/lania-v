/**
 * 基于事件冒泡的 Context 实现（不依赖框架运行时全局）。
 *
 * - `provideContext` 在某个 host 上监听 context-request 事件并拦截/resolve；
 *   组件体内的两参形式是编译期语法糖，会被改写成 `provideContext(this, ...)`；
 * - `consumeContext` 通过派发事件向上冒泡寻找最近的 provider（内部原语）；
 * - 适用于 Custom Element 与函数组件混用的场景（只要能 dispatchEvent）。
 */

import {
  createSignal,
  readonly,
  type ReadonlySignal,
} from '@lania-v/reactivity';

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
  return (
    typeof value === 'function' &&
    value !== null &&
    'updaters' in (value as object)
  );
};

const toReadonlySignal = <T>(
  value: ContextValueProvider<T>
): ReadonlySignal<T> => {
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

const isContext = <T>(value: unknown): value is Context<T> => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof (value as Context<T>).id === 'symbol'
  );
};

export function provideContext<T>(
  host: EventTarget,
  context: Context<T>,
  value: ContextValueProvider<T>
): () => void;
/**
 * 编译期语法糖：在组件体内调用两参形式，编译器会改写成
 * `provideContext(this, context, value)`。未编译时直接调用会抛错。
 */
export function provideContext<T>(
  context: Context<T>,
  value: ContextValueProvider<T>
): never;
export function provideContext<T>(
  hostOrContext: EventTarget | Context<T>,
  contextOrValue: Context<T> | ContextValueProvider<T>,
  maybeValue?: ContextValueProvider<T>
): (() => void) | never {
  if (isContext<T>(hostOrContext)) {
    throw new Error(
      'provideContext(context, value) is compile-time only. Use provideContext(host, context, value) outside a compiled component.'
    );
  }

  const host = hostOrContext as EventTarget;
  const context = contextOrValue as Context<T>;
  const provided = toReadonlySignal(maybeValue as ContextValueProvider<T>);
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
}

export const consumeContext = <T>(
  host: { dispatchEvent(event: Event): boolean },
  context: Context<T>
): ReadonlySignal<T> => {
  let resolvedValue = context.defaultValue;

  const event = new CustomEvent<ContextRequestDetail<T>>(
    CONTEXT_REQUEST_EVENT,
    {
      bubbles: true,
      composed: true,
      cancelable: true,
      detail: {
        context,
        resolve(value) {
          resolvedValue = value;
        },
      },
    }
  );

  host.dispatchEvent(event);
  return resolvedValue;
};
