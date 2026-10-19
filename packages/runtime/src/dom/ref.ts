/**
 * 实现模板与组件层共享的 ref 写入工具。
 *
 * 既支持对象 ref，也支持函数 ref；批量写入场景会被压到微任务中统一刷新。
 */
export interface RefObject<T> {
  current: T | null;
}

export type RefBinding<T> = RefObject<T> | ((value: T | null) => void);

/**
 * 声明一个可直接读取绑定结果的模板引用。
 *
 * 编译期会把 `const input = createRef<HTMLInputElement>()` 改写成组件实例字段
 * `input: HTMLInputElement | null = null`，并把 `ref={input}` 改写成对该字段赋值，
 * 因此业务代码可以直接写 `input?.focus()`，不需要 `.current`。
 *
 * 这个函数本身只是编译期标记：未编译直接调用会抛错，避免得到静默失效的空引用。
 */
export const createRef = <T>(): T => {
  throw new Error(
    'createRef() is compile-time only. It must be rewritten by the Lania compiler inside a compiled component instead of running in the public runtime directly.'
  );
};

// 对象 ref 直接改 current，函数 ref 则立即回调。
const applyRefValue = <T>(
  ref: RefBinding<T> | null | undefined,
  value: T | null
): void => {
  if (!ref) {
    return;
  }

  if (typeof ref === 'function') {
    ref(value);
    return;
  }

  // 编译产物里的 `ref={inputRef}` 会被改写成赋值函数，这里只兜底真正的对象 ref。
  if ('current' in ref) {
    ref.current = value;
  }
};

const pendingRefWrites = new Map<RefBinding<unknown>, unknown>();
let refWriteScheduled = false;

// 多次 queueRefWrite 会被同一轮微任务合并，保证只应用最后一次值。
const flushQueuedRefWrites = (): void => {
  refWriteScheduled = false;
  const entries = [...pendingRefWrites.entries()];
  pendingRefWrites.clear();

  entries.forEach(([ref, value]) => {
    applyRefValue(ref as RefBinding<unknown>, value as unknown | null);
  });
};

// 异步队列写入适合 DOM patch 过程中暂存 ref，待节点稳定后再统一更新。
export const queueRefWrite = <T>(
  ref: RefBinding<T> | null | undefined,
  value: T | null
): void => {
  if (!ref) {
    return;
  }

  pendingRefWrites.set(ref as RefBinding<unknown>, value);

  if (!refWriteScheduled) {
    refWriteScheduled = true;
    queueMicrotask(flushQueuedRefWrites);
  }
};

export const setRef = <T>(
  ref: RefBinding<T> | null | undefined,
  value: T | null
): void => {
  applyRefValue(ref, value);
};

// `createExpose()` 记录的暴露面：组件 ref 需要优先写入它，而不是宿主元素。
const exposedRefValues = new WeakMap<object, unknown>();

export const markRefExposed = (ref: unknown, exposed: object): void => {
  if ((typeof ref === 'function' || typeof ref === 'object') && ref !== null) {
    exposedRefValues.set(ref, exposed);
  }
};

export const readRefExposed = (ref: unknown): unknown => {
  if ((typeof ref === 'function' || typeof ref === 'object') && ref !== null) {
    return exposedRefValues.get(ref);
  }

  return undefined;
};
