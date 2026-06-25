/**
 * 封装 Transition/TransitionGroup 的异步 hook 调度。
 *
 * 它会兼容同步返回、Promise、Animation，以及尚未接入 DOM 的节点延迟执行等细节。
 */
import {
  createNamedHooks,
  type TransitionHookContextShape,
  type TransitionHookEntry,
} from './registry';
import type {
  TransitionDispatchContext,
  TransitionDispatchHook,
  TransitionDispatchOptions,
} from './host-types';

// 单个 hook 执行时会记录执行前后的动画集合，用于等待新启动的动画完成。
const runTransitionHook = <TContext extends TransitionDispatchContext>(
  hook: TransitionDispatchHook<TContext> | undefined,
  element: Element,
  context: TContext
): Promise<void> => {
  if (!hook) {
    return Promise.resolve();
  }

  try {
    const canReadAnimations = typeof element.getAnimations === 'function';
    const isLeave = context.phase === 'leave';

    const invoke = (): Promise<{ result: unknown; animationsBefore: Animation[] }> => {
      const run = () => {
        const animationsBefore = canReadAnimations
          ? element.getAnimations().filter((animation) => animation.playState !== 'finished')
          : [];
        const result = hook(element, context);
        return { result, animationsBefore };
      };

      if (!isLeave) {
        return Promise.resolve(run());
      }

      return new Promise((resolve) => {
        requestAnimationFrame(() => resolve(run()));
      });
    };

    return invoke().then(({ result, animationsBefore }) => {
      if (typeof Animation !== 'undefined' && result instanceof Animation) {
        return result.finished.then(() => undefined, () => undefined);
      }

      const awaited = Promise.resolve(result).then(() => undefined);
      if (!canReadAnimations) {
        return awaited;
      }

      return awaited.then(async () => {
        const animationsAfter = element
          .getAnimations()
          .filter((animation) => animation.playState !== 'finished');
        const newAnimations = animationsAfter.filter(
          (animation) => !animationsBefore.includes(animation)
        );

        if (newAnimations.length === 0) {
          return;
        }

        await Promise.allSettled(
          newAnimations.map((animation) => animation.finished.then(() => undefined, () => undefined))
        );
      });
    });
  } catch (error) {
    return Promise.reject(error);
  }
};

const pendingTransitionHooks = new WeakMap<Element, Array<() => void>>();
let deferredTransitionHookDepth = 0;

export const scheduleTransitionHooks = <TContext extends TransitionDispatchContext>(
  hook: TransitionDispatchHook<TContext> | undefined,
  entries: Array<TransitionHookEntry<TContext>>,
  onSettled?: () => void
): void => {
  if (entries.length === 0) {
    onSettled?.();
    return;
  }

  queueMicrotask(() => {
    void Promise.allSettled(
      entries.map(({ element, context }) => runTransitionHook(hook, element, context))
    ).then(() => {
      onSettled?.();
    });
  });
};

// 尚未连入文档的节点先把任务挂到 WeakMap，待节点真正插入后再统一冲刷。
const queueDeferredHooks = <TContext extends TransitionDispatchContext>(
  hook: TransitionDispatchHook<TContext> | undefined,
  entries: Array<TransitionHookEntry<TContext>>,
  onSettled?: () => void
): void => {
  if (entries.length === 0) {
    onSettled?.();
    return;
  }

  if (entries.every(({ element }) => element.isConnected)) {
    scheduleTransitionHooks(hook, entries, onSettled);
    return;
  }

  let remaining = entries.length;
  const settleOne = () => {
    remaining -= 1;
    if (remaining === 0) {
      onSettled?.();
    }
  };

  entries.forEach(({ element, context }) => {
    const jobs = pendingTransitionHooks.get(element) ?? [];
    jobs.push(() => {
      void Promise.resolve(runTransitionHook(hook, element, context)).finally(settleOne);
    });
    pendingTransitionHooks.set(element, jobs);
  });
};

const shouldDeferTransitionHooks = (): boolean => {
  return deferredTransitionHookDepth > 0;
};

// defer 开启时，嵌套的过渡提交会先缓存 hook，避免节点尚未连接时过早执行。
export const dispatchTransitionHooks = <TContext extends TransitionDispatchContext>(
  hook: TransitionDispatchHook<TContext> | undefined,
  entries: Array<TransitionHookEntry<TContext>>,
  options: TransitionDispatchOptions = {}
): void => {
  const { defer = true, onSettled } = options;
  const dispatch =
    defer && shouldDeferTransitionHooks() ? queueDeferredHooks : scheduleTransitionHooks;
  dispatch(hook, entries, onSettled);
};

export const dispatchNamedHooks = (
  hook: TransitionDispatchHook<TransitionHookContextShape> | undefined,
  elements: readonly Element[],
  name: string | undefined,
  phase: TransitionHookContextShape['phase'],
  options: TransitionDispatchOptions = {}
): void => {
  dispatchTransitionHooks(hook, createNamedHooks(elements, name, phase), options);
};

// 通过计数器标记当前处于 defer 区间，支持多层嵌套调用。
export const withDeferredTransitionHooks = <T>(run: () => T): T => {
  deferredTransitionHookDepth += 1;

  try {
    return run();
  } finally {
    deferredTransitionHookDepth -= 1;
  }
};

// 节点真正挂上 DOM 后递归冲刷其延迟 hook。
export const flushHooksForNodes = (nodes: readonly Node[]): void => {
  const visit = (node: Node): void => {
    if (node instanceof Element) {
      const jobs = pendingTransitionHooks.get(node);
      if (jobs && jobs.length > 0) {
        pendingTransitionHooks.delete(node);
        jobs.forEach((job) => job());
      }
    }

    node.childNodes.forEach((child) => visit(child));
  };

  nodes.forEach((node) => visit(node));
};
