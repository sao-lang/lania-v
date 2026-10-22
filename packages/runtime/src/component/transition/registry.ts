/**
 * 单节点过渡状态注册表与通用 hook 辅助。
 *
 * 该文件把 `Transition` / `TransitionGroup` 都会依赖的一组基础能力集中起来：
 * - 以 `stateKey` 为索引缓存最近一次过渡状态；
 * - 管理 leaving 过程使用的 snapshot 与 leaveVersion；
 * - 生成统一的调试摘要，供上层在 render/commit 前读取；
 * - 把元素数组包装成 hook entry，并提供 finalize 回调生成器。
 *
 * 这里不直接决定“何时 enter/leave”，而是负责维持跨次渲染共享的状态真相，
 * 让更高层 runtime 可以稳定地读取 previous、开启离场并在结束后回收 snapshot。
 */
import {
  createBaseTransitionDebugSummary,
  type BaseTransitionDebugSummary,
} from './runtime';

export interface TransitionLeaveEntry {
  leaveVersion: number;
}

export interface TransitionLeavingEntry<
  TRenderable,
> extends TransitionLeaveEntry {
  snapshot: TRenderable;
}

export interface TransitionState<TRenderable> {
  visible: boolean;
  appeared: boolean;
  snapshot: TRenderable | null;
  leaving: boolean;
  leaveVersion: number;
}

export interface LeaveFinalizeHost {
  requestUpdate?: () => void;
}

export type TransitionPhase = 'enter' | 'leave' | 'appear' | 'move';

export interface TransitionHookEntry<TContext> {
  element: Element;
  context: TContext;
}

export interface TransitionHookContextShape {
  name?: string;
  phase: TransitionPhase;
}

export interface GroupHookContext extends TransitionHookContextShape {
  key: PropertyKey;
  index: number;
  previousIndex?: number;
}

// 单节点过渡按 stateKey 持久化状态；不同组件实例可通过 key 隔离彼此生命周期。
const transitionStates = new Map<string, TransitionState<unknown>>();

export const __resetTransitionStateForTests = (): void => {
  transitionStates.clear();
};

const setTransitionState = <TRenderable>(
  stateKey: string,
  state: TransitionState<TRenderable>
): TransitionState<TRenderable> => {
  // 统一通过该入口写回，便于所有状态迁移都落到同一张表。
  transitionStates.set(stateKey, state as TransitionState<unknown>);
  return state;
};

export const getTransitionState = <TRenderable>(
  stateKey: string
): TransitionState<TRenderable> | undefined => {
  return transitionStates.get(stateKey) as
    TransitionState<TRenderable> | undefined;
};

export const createDebugSummary = <TRenderable>(
  previous: TransitionState<TRenderable> | undefined
): BaseTransitionDebugSummary => {
  // 调试摘要只暴露布尔/可空信息，避免把完整 snapshot 泄漏到外层调试输出。
  return createBaseTransitionDebugSummary({
    hasPrevious: Boolean(previous),
    previousVisible: previous?.visible,
    previousAppeared: previous?.appeared,
    previousLeaving: previous?.leaving,
    hasSnapshot: Boolean(previous?.snapshot),
  });
};

export const resolveLeaveEntry = <TEntry extends TransitionLeaveEntry>(
  entries: Map<PropertyKey, TEntry>,
  key: PropertyKey,
  leaveVersion: number
): TEntry | null => {
  const resolved = entries.get(key);
  // 只有版本号仍匹配时才认为该 leaving entry 有效，防止旧异步回调误删新状态。
  return resolved && resolved.leaveVersion === leaveVersion ? resolved : null;
};

export const deleteLeaveEntry = <TEntry extends TransitionLeaveEntry>(
  entries: Map<PropertyKey, TEntry>,
  key: PropertyKey,
  leaveVersion: number
): { entry: TEntry | null; nextEntries: Map<PropertyKey, TEntry> | null } => {
  const entry = resolveLeaveEntry(entries, key, leaveVersion);
  if (!entry) {
    return { entry: null, nextEntries: null };
  }

  const nextEntries = new Map(entries);
  nextEntries.delete(key);
  return { entry, nextEntries };
};

export const setTransitionVisibleState = <TRenderable>(
  stateKey: string,
  snapshot: TRenderable,
  previous?: TransitionState<TRenderable>
): TransitionState<TRenderable> => {
  // 一旦提交 visible，snapshot 就切换为当前渲染结果，并把 appeared 固定为 true。
  return setTransitionState(stateKey, {
    visible: true,
    appeared: true,
    snapshot,
    leaving: false,
    leaveVersion: previous?.leaveVersion ?? 0,
  });
};

export const setTransitionExitedState = <TRenderable>(
  stateKey: string,
  previous?: TransitionState<TRenderable>
): TransitionState<TRenderable> => {
  return setTransitionState<TRenderable>(stateKey, {
    visible: false,
    appeared: previous?.appeared ?? false,
    snapshot: null,
    leaving: false,
    leaveVersion: previous?.leaveVersion ?? 0,
  });
};

export const retainTransitionLeavingState = <TRenderable>(
  stateKey: string,
  previous: TransitionState<TRenderable>
): TransitionState<TRenderable> => {
  // retained leaving 表示继续保留旧 snapshot 做离场展示，但逻辑可见性已变为 false。
  return setTransitionState(stateKey, {
    ...previous,
    visible: false,
  });
};

export const beginTransitionLeaving = <TRenderable>(
  stateKey: string,
  previous: TransitionState<TRenderable>
): TransitionLeavingEntry<TRenderable> | null => {
  if (!previous.snapshot) {
    return null;
  }

  // 离场开始时递增 leaveVersion，用来和稍后 settle 的 finalize 回调配对。
  const entry: TransitionLeavingEntry<TRenderable> = {
    snapshot: previous.snapshot,
    leaveVersion: previous.leaveVersion + 1,
  };
  setTransitionState(stateKey, {
    visible: false,
    appeared: previous.appeared,
    snapshot: entry.snapshot,
    leaving: true,
    leaveVersion: entry.leaveVersion,
  });
  return entry;
};

export const finalizeLeaving = <TRenderable>(
  stateKey: string,
  leaveVersion: number
): TransitionState<TRenderable> | null => {
  const current = getTransitionState<TRenderable>(stateKey);
  if (!current || !current.leaving || current.leaveVersion !== leaveVersion) {
    // 若期间已发生下一轮提交，旧 finalize 不应再改写当前状态。
    return null;
  }

  return setTransitionState<TRenderable>(stateKey, {
    ...current,
    snapshot: null,
    leaving: false,
  });
};

export const createFinalizeHandler = <TFinalized>(options: {
  finalize: () => TFinalized | null;
  host?: LeaveFinalizeHost;
  onFinalized?: (value: TFinalized) => void;
}): (() => void) => {
  const { finalize, host, onFinalized } = options;

  return () => {
    const finalized = finalize();
    if (!finalized) {
      return;
    }

    // finalize 成功后同时通知业务侧和宿主侧，后者通常会触发一次重新渲染清理残留节点。
    onFinalized?.(finalized);
    host?.requestUpdate?.();
  };
};

export const createHookEntries = <TContext>(
  elements: readonly Element[],
  context: TContext
): Array<TransitionHookEntry<TContext>> => {
  return elements.map((element) => ({
    element,
    context,
  }));
};

export const createNamedHooks = (
  elements: readonly Element[],
  name: string | undefined,
  phase: TransitionPhase
): Array<TransitionHookEntry<TransitionHookContextShape>> => {
  return createHookEntries(elements, {
    name,
    phase,
  });
};

export const createGroupHooks = (
  elements: readonly Element[],
  context: GroupHookContext
): Array<TransitionHookEntry<GroupHookContext>> => {
  return createHookEntries(elements, context);
};
