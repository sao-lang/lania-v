/**
 * 显式 key 驱动的异步资源封装。
 *
 * 这个实现没有引入自动依赖收集，而是要求调用方把会触发重拉取的 signal 明确传进来。
 * 这样资源层的行为更稳定，也更适合被编译产物直接使用：
 * - 任一 key signal 变更后，调度一次 `refetch`
 * - 通过 `loading` / `error` 暴露请求状态
 * - 使用递增 `requestId` 丢弃过期响应，避免竞态覆盖最新结果
 */
import { defaultScheduler, type Scheduler } from './scheduler';
import {
  createSignal,
  readonly,
  type ReadonlySignal,
  type Signal,
} from './signal';

export interface ResourceControls<T> {
  loading: ReadonlySignal<boolean>;
  error: ReadonlySignal<unknown>;
  refetch(): Promise<T | undefined>;
}

const attachJobToSignals = (signals: Iterable<Signal<any>>, job: () => void): void => {
  for (const signal of signals) {
    // 资源不做依赖 diff，直接把同一个调度 job 订阅到所有 key signal 上。
    signal.updaters.add(job);
  }
};

const detachJobFromSignals = (signals: Iterable<Signal<any>>, job: () => void): void => {
  for (const signal of signals) {
    signal.updaters.delete(job);
  }
};

export type ResourceKey = Signal<any> | readonly Signal<any>[];
export const createResource = <T>(
  key: ResourceKey,
  fetcher: () => Promise<T>,
  options: {
    initialValue?: T;
    scheduler?: Scheduler;
  } = {}
): [ReadonlySignal<T | undefined>, ResourceControls<T>] => {
  const scheduler = options.scheduler ?? defaultScheduler;
  const value = createSignal<T | undefined>(options.initialValue, scheduler);
  const loading = createSignal(false, scheduler);
  const error = createSignal<unknown>(undefined, scheduler);
  let requestId = 0;
  const keys = Array.isArray(key) ? key : [key];

  const run = async (): Promise<T | undefined> => {
    const currentRequestId = ++requestId;
    loading.set(true);

    try {
      const result = await fetcher();

      if (currentRequestId === requestId) {
        // 只有最后一次请求允许提交结果，防止慢请求回写旧数据。
        value.set(result);
        error.set(undefined);
      }

      return result;
    } catch (reason) {
      if (currentRequestId === requestId) {
        error.set(reason);
      }

      return undefined;
    } finally {
      if (currentRequestId === requestId) {
        loading.set(false);
      }
    }
  };

  const scheduleRefetch = () => {
    // 通过 effect 队列触发异步重拉取，避免在 signal 通知过程中立刻再入 fetcher。
    scheduler.scheduleEffect(() => {
      void run();
    });
  };

  attachJobToSignals(keys, scheduleRefetch);
  // 创建资源时立即拉一次首屏数据，行为与常见 resource 原语保持一致。
  void run();

  return [
    readonly(value),
    {
      loading: readonly(loading),
      error: readonly(error),
      refetch: run,
    },
  ];
};
