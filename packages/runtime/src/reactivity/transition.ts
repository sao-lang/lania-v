/**
 * 低优先级更新入口。
 *
 * `startTransition()` 只影响同步写入阶段的 signal 调度优先级：
 * - 批内 `set` 会进入 LOW 桶，普通交互不会被大列表更新阻塞；
 * - `pending` 在整批稳定 flush 后自动回落，便于渲染 loading 态。
 *
 * 它不改变信号依赖模型，也不引入新的渲染阶段，因此现有编译产物无需感知。
 */
import { LOW, tick, withSignalPriority } from './scheduler';
import { createSignal, readonly, type ReadonlySignal } from './signal';

const pendingFlag = createSignal(false);
let pendingCount = 0;

const decrementPending = (): void => {
  void tick().then(() => {
    pendingCount = Math.max(0, pendingCount - 1);

    if (pendingCount === 0) {
      pendingFlag.set(false);
    }
  });
};

export const startTransition = <T>(run: () => T): T => {
  pendingCount += 1;
  // 同步置位，保证调用方在同一个 tick 内就能渲染 loading 态。
  pendingFlag.set(true);

  try {
    return withSignalPriority(LOW, run);
  } finally {
    decrementPending();
  }
};

export interface TransitionControls {
  pending: ReadonlySignal<boolean>;
  start: typeof startTransition;
}

export const transitionPending: ReadonlySignal<boolean> = readonly(pendingFlag);

export const useTransition = (): TransitionControls => {
  return {
    pending: transitionPending,
    start: startTransition,
  };
};

export const __resetTransitionPendingForTests = (): void => {
  pendingCount = 0;
  pendingFlag.set(false);
};
