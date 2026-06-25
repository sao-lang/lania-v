/**
 * 实现模板与组件层共享的 ref 写入工具。
 *
 * 既支持对象 ref，也支持函数 ref；批量写入场景会被压到微任务中统一刷新。
 */
export interface RefObject<T> {
  current: T | null;
}

export type RefBinding<T> = RefObject<T> | ((value: T | null) => void);

export const createRef = <T>(): RefObject<T> => {
  return {
    current: null,
  };
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

  ref.current = value;
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
