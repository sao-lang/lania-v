/**
 * TransitionGroup 阶段调度与离场收尾逻辑。
 *
 * 该文件负责把列表过渡拆成几条稳定的运行时路径：
 * - 离场项登记到状态仓库，并在动画结束后完成清理；
 * - appear / enter / move 三类阶段根据 key 变化筛选出目标项；
 * - 普通 snapshot 模式直接基于快照元素派发 hooks；
 * - DOM host 模式延后到微任务中读取最新 block，确保真实 DOM 顺序已稳定。
 *
 * 这里不直接操作编译产物，而是围绕 TransitionGroupState 做增量调度，
 * 让“哪些项该播什么动画”和“动画结束后如何收尾”维持在同一处。
 * 额外要注意两类时序约束：
 * - leave 收尾依赖 `leaveVersion` 防止旧回调误删同 key 的新状态；
 * - DOM host 阶段调度刻意延后到微任务，避免在 block/DOM 尚未稳定时读取到旧元素顺序。
 *
 * 可以把这里看成 TransitionGroup 的“时序编排层”：
 * - state 模块负责存什么；
 * - registry/host 模块负责怎么派发 hook；
 * - 本文件负责决定什么时候登记 leaving、什么时候补发 appear/enter/move。
 */
import { dispatchTransitionHooks, type TransitionDispatchHook } from '../../host';
import {
  createGroupHooks,
  createFinalizeHandler,
  type GroupHookContext,
  type LeaveFinalizeHost,
} from '../../registry';
import { getTransitionGroupState, setTransitionGroupState, updateTransitionGroupState } from '../state/store';
import {
  createLeavingSnapshot,
  deleteLeavingEntry,
} from '../state/state';
import type {
  GroupLeaveEntry,
  GroupLeavingBlock,
  GroupLeavingSnapshot,
  GroupPhaseEnabled,
  GroupPhaseHooks,
  GroupPhaseItem,
  TransitionGroupState,
} from '../types';

export const createFinalizer = <TFinalized>(options: {
  finalize: () => TFinalized | null;
  host?: LeaveFinalizeHost;
  onFinalized?: (finalized: TFinalized) => void;
}): (() => void) => {
  const { finalize, host, onFinalized } = options;
  // finalize 只允许生效一次，具体幂等保护交给 registry 层的统一封装。
  return createFinalizeHandler({
    finalize,
    host,
    onFinalized,
  });
};

export const dispatchLeavingHooks = (options: {
  hook?: TransitionDispatchHook<GroupHookContext>;
  elements: readonly Element[];
  entry: GroupLeaveEntry;
  name?: string;
  onSettled: () => void;
}): void => {
  const { hook, elements, entry, name, onSettled } = options;
  // leave 阶段固定使用元素离开前的旧索引，这样 hook 能看到“从哪里离开”。
  dispatchTransitionHooks(
    hook,
    createGroupHooks(elements, {
      key: entry.key,
      index: entry.previousIndex,
      previousIndex: entry.previousIndex,
      name,
      phase: 'leave',
    }),
    {
      defer: false,
      onSettled,
    }
  );
};

export const finalizeSnapState = <
  TState,
  TRenderable,
>(
  current: TState,
  key: PropertyKey,
  leaveVersion: number,
  selectLeavingSnapshots: (
    state: TState
  ) => Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>,
  assignLeavingSnapshots: (
    state: TState,
    leavingSnapshots: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>
  ) => TState
): TState | null => {
  // 只有 leaveVersion 仍然匹配时才真正删除，避免旧动画回调误删新一轮同 key 状态。
  const removed = deleteLeavingEntry(
    selectLeavingSnapshots(current),
    key,
    leaveVersion
  );
  return removed.nextEntries ? assignLeavingSnapshots(current, removed.nextEntries) : null;
};

export const finalizeBlockState = <TState>(
  current: TState,
  key: PropertyKey,
  leaveVersion: number,
  selectLeavingBlocks: (
    state: TState
  ) => Map<PropertyKey, GroupLeavingBlock>,
  assignLeavingBlocks: (
    state: TState,
    leavingBlocks: Map<PropertyKey, GroupLeavingBlock>
  ) => TState
): { nextState: TState | null; entry: GroupLeavingBlock | null } => {
  const removed = deleteLeavingEntry(
    selectLeavingBlocks(current),
    key,
    leaveVersion
  );
  return {
    nextState: removed.nextEntries ? assignLeavingBlocks(current, removed.nextEntries) : null,
    entry: removed.entry,
  };
};

export const finalizeLeavingSnapshot = <TRenderable>(
  stateKey: string,
  key: PropertyKey,
  leaveVersion: number
): TransitionGroupState<TRenderable> | null => {
  const current = getTransitionGroupState<TRenderable>(stateKey);
  if (!current) {
    return null;
  }

  const next = finalizeSnapState(
    current,
    key,
    leaveVersion,
    (state) => state.leavingSnapshots,
    (state, leavingSnapshots) => ({
      ...state,
      leavingSnapshots,
    })
  );
  return next ? setTransitionGroupState(stateKey, next) : null;
};

export const finalizeLeavingBlock = (
  stateKey: string,
  key: PropertyKey,
  leaveVersion: number
): GroupLeavingBlock | null => {
  const current = getTransitionGroupState<unknown>(stateKey);
  if (!current) {
    return null;
  }

  const removed = finalizeBlockState(
    current,
    key,
    leaveVersion,
    (state) => state.leavingBlocks,
    (state, leavingBlocks) => ({
      ...state,
      leavingBlocks,
    })
  );
  if (!removed.entry || !removed.nextState) {
    // 任一条件不满足都视为这次 finalize 已经过期或已被消费，直接忽略。
    return null;
  }

  setTransitionGroupState(stateKey, removed.nextState);
  return removed.entry;
};

export const registerBlockState = (
  stateKey: string,
  entry: GroupLeavingBlock
): TransitionGroupState<unknown> | null => {
  // leaving block 也要推进 leaveVersion，保证 finalize 时能辨认当前轮次。
  return updateTransitionGroupState<unknown>(stateKey, (current) => ({
    ...current,
    leaveVersion: entry.leaveVersion,
    leavingBlocks: (() => {
      const next = new Map(current.leavingBlocks);
      next.set(entry.key, entry);
      return next;
    })(),
  }));
};

export const createBlockFinalizer = (
  stateKey: string,
  entry: GroupLeavingBlock
): (() => void) => {
  return createFinalizer({
    finalize: () =>
      finalizeLeavingBlock(stateKey, entry.key, entry.leaveVersion),
    onFinalized: (finalized) => {
      // block 离场完成后既要销毁 bindings，也要把占位节点从宿主中摘掉。
      finalized.block.destroyBindings();
      finalized.block.finalizeRemoval();
    },
  });
};

export const scheduleLeavingBlock = (options: {
  stateKey: string;
  entry: GroupLeavingBlock;
  previousIndex: number;
  name?: string;
  hook?: TransitionDispatchHook<GroupHookContext>;
}): void => {
  const { stateKey, entry, name, hook } = options;
  dispatchLeavingHooks({
    hook,
    elements: entry.block.getElements(),
    entry,
    name,
    onSettled: createBlockFinalizer(stateKey, entry),
  });
};

export const registerLeavingSnapshot = <TRenderable>(options: {
  state: TransitionGroupState<TRenderable>;
  nextLeavingSnapshots: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>;
  key: PropertyKey;
  previousIndex: number;
  snapshot: TRenderable;
  stateKey: string;
  host?: LeaveFinalizeHost;
}): {
  entry: GroupLeavingSnapshot<TRenderable>;
  finalize: () => void;
} => {
  const {
    state,
    nextLeavingSnapshots,
    key,
    previousIndex,
    snapshot,
    stateKey,
    host,
  } = options;
  // 同一轮更新中 leaveVersion 递增，避免多个离场 key 的 finalize 互相覆盖。
  const leaveVersion = state.leaveVersion + nextLeavingSnapshots.size + 1;
  const entry = createLeavingSnapshot(
    key,
    snapshot,
    previousIndex,
    leaveVersion
  );
  nextLeavingSnapshots.set(key, entry);

  return {
    entry,
    finalize: createFinalizer({
      finalize: () =>
        finalizeLeavingSnapshot(stateKey, key, leaveVersion),
      host,
    }),
  };
};

export const scheduleLeavingSnapshot = <TRenderable>(options: {
  state: TransitionGroupState<TRenderable>;
  nextLeavingSnapshots: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>;
  key: PropertyKey;
  previousIndex: number;
  snapshot: TRenderable;
  stateKey: string;
  host?: LeaveFinalizeHost;
  hook?: TransitionDispatchHook<GroupHookContext>;
  name?: string;
  enabled: boolean;
  getElements: (snapshot: TRenderable) => readonly Element[];
}): GroupLeavingSnapshot<TRenderable> => {
  const {
    state,
    nextLeavingSnapshots,
    key,
    previousIndex,
    snapshot,
    stateKey,
    host,
    hook,
    name,
    enabled,
    getElements,
  } = options;
  const { entry, finalize } = registerLeavingSnapshot({
    state,
    nextLeavingSnapshots,
    key,
    previousIndex,
    snapshot,
    stateKey,
    host,
  });

  if (!enabled) {
    // 关闭离场动画时立即 finalize，只保留状态迁移语义，不保留异步过渡。
    finalize();
    return entry;
  }

  dispatchLeavingHooks({
    hook,
    elements: getElements(snapshot),
    entry,
    name,
    onSettled: finalize,
  });
  return entry;
};

export const collectPhaseItems = (options: {
  phase: 'appear' | 'enter' | 'move';
  keys: readonly PropertyKey[];
  previousKeys?: readonly PropertyKey[];
}): GroupPhaseItem[] => {
  const { phase, keys, previousKeys } = options;

  if (phase === 'appear') {
    // 首屏没有 previousKeys，所有当前项都视为 appear 目标。
    return keys.map((key, index) => ({ key, index }));
  }

  return keys.flatMap((key, index) => {
    const previousIndex = previousKeys?.indexOf(key) ?? -1;
    // previousIndex 统一先算出来，enter/move 共享同一份“旧位置”判断结果。
    if (phase === 'enter') {
      // 仅新出现的 key 参与 enter。
      return previousIndex === -1 ? [{ key, index }] : [];
    }

    // move 只关心“同 key 仍存在但索引改变”的项。
    return previousIndex !== -1 && previousIndex !== index
      ? [{ key, index, previousIndex }]
      : [];
  });
};

export const dispatchSnapshotPhase = <TRenderable>(options: {
  phase: 'appear' | 'enter' | 'move';
  keys: readonly PropertyKey[];
  snapshots: readonly TRenderable[];
  previousKeys?: readonly PropertyKey[];
  name?: string;
  hook?: TransitionDispatchHook<GroupHookContext>;
  getElements: (snapshot: TRenderable) => readonly Element[];
  defer?: boolean;
}): void => {
  const {
    phase,
    keys,
    snapshots,
    previousKeys,
    name,
    hook,
    getElements,
    defer = true,
  } = options;
  const items = collectPhaseItems({ phase, keys, previousKeys });
  if (items.length === 0) {
    return;
  }

  // snapshot 模式直接从渲染产物里取元素，不需要等待 block 注册完成。
  const entries = items.flatMap(({ key, index, previousIndex }) =>
    createGroupHooks(getElements(snapshots[index] as TRenderable), {
      key,
      index,
      previousIndex,
      name,
      phase,
    })
  );
  dispatchTransitionHooks(hook, entries, { defer });
};

const isGroupPhaseEnabled = (
  enabled: GroupPhaseEnabled | undefined,
  phase: 'appear' | 'enter' | 'move'
): boolean => {
  return enabled?.[phase] ?? true;
};

export const dispatchSnapshotPhases = <TRenderable>(options: {
  keys: readonly PropertyKey[];
  snapshots: readonly TRenderable[];
  previousKeys?: readonly PropertyKey[];
  name?: string;
  hooks?: GroupPhaseHooks;
  enabled?: GroupPhaseEnabled;
  getElements: (snapshot: TRenderable) => readonly Element[];
  defer?: boolean;
}): void => {
  const { keys, snapshots, previousKeys, name, hooks, enabled, getElements, defer } = options;

  if (!previousKeys) {
    if (!isGroupPhaseEnabled(enabled, 'appear')) {
      return;
    }

    dispatchSnapshotPhase({
      phase: 'appear',
      keys,
      snapshots,
      name,
      hook: hooks?.appear,
      getElements,
      defer,
    });
    return;
  }

  if (isGroupPhaseEnabled(enabled, 'move')) {
    // move 通常依赖旧索引与新索引对比，因此在已有 previousKeys 时优先调度。
    dispatchSnapshotPhase({
      phase: 'move',
      keys,
      snapshots,
      previousKeys,
      name,
      hook: hooks?.move,
      getElements,
      defer,
    });
  }

  if (isGroupPhaseEnabled(enabled, 'enter')) {
    // enter 放在 move 之后，让已存在元素先完成位置判定，再处理新增项。
    dispatchSnapshotPhase({
      phase: 'enter',
      keys,
      snapshots,
      previousKeys,
      name,
      hook: hooks?.enter,
      getElements,
      defer,
    });
  }
};

export const scheduleDomHostPhase = (options: {
  stateKey: string;
  container: HTMLElement;
  keys: readonly PropertyKey[];
  phase: 'appear' | 'enter' | 'move';
  items?: readonly GroupPhaseItem[];
  name?: string;
  hook?: TransitionDispatchHook<GroupHookContext>;
}): void => {
  const { stateKey, container, keys, phase, items: requestedItems, name, hook } = options;
  queueMicrotask(() => {
    // DOM host 模式需要等 block 和容器都稳定后再读状态，否则拿到的元素顺序可能还是旧的。
    const current = getTransitionGroupState<unknown>(stateKey);
    if (!current || current.container !== container) {
      // 容器引用变化说明这轮调度对应的宿主已失效，不能再继续派发旧阶段。
      return;
    }
    if (
      current.keys.length !== keys.length ||
      current.keys.some((key, index) => !Object.is(key, keys[index]))
    ) {
      // key 序列已变化时，本次微任务里的阶段判定也随之失效，避免对错误元素发 hooks。
      return;
    }

    const items: GroupPhaseItem[] =
      phase === 'appear'
        ? keys.map((key, index) => ({ key, index }))
        : [...(requestedItems ?? [])];
    if (phase !== 'appear' && items.length === 0) {
      return;
    }

    const entries = items.flatMap(({ key, index, previousIndex }) => {
      const block = current.activeBlocks.get(key);
      if (!block) {
        // 某个 key 可能已在同一微任务内被移除，直接跳过。
        return [];
      }

      return createGroupHooks(block.getElements(), {
        key,
        index,
        previousIndex,
        name,
        phase,
      });
    });
    dispatchTransitionHooks(hook, entries, { defer: false });
  });
};

export const scheduleDomHostPhases = (options: {
  stateKey: string;
  container: HTMLElement;
  keys: readonly PropertyKey[];
  previousKeys?: readonly PropertyKey[];
  name?: string;
  hooks?: GroupPhaseHooks;
  enabled?: GroupPhaseEnabled;
}): void => {
  const { stateKey, container, keys, previousKeys, name, hooks, enabled } = options;

  if (!previousKeys) {
    if (!isGroupPhaseEnabled(enabled, 'appear')) {
      return;
    }

    scheduleDomHostPhase({
      stateKey,
      container,
      keys,
      phase: 'appear',
      name,
      hook: hooks?.appear,
    });
    return;
  }

  const moveItems = collectPhaseItems({
    phase: 'move',
    keys,
    previousKeys,
  });
  // 这里先在同步阶段算出目标 key 集，再把真实 DOM 读取推迟到微任务，兼顾正确性与时序稳定。
  if (moveItems.length > 0 && isGroupPhaseEnabled(enabled, 'move')) {
    scheduleDomHostPhase({
      stateKey,
      container,
      keys,
      phase: 'move',
      items: moveItems,
      name,
      hook: hooks?.move,
    });
  }

  const enterItems = collectPhaseItems({
    phase: 'enter',
    keys,
    previousKeys,
  });
  if (enterItems.length > 0 && isGroupPhaseEnabled(enabled, 'enter')) {
    scheduleDomHostPhase({
      stateKey,
      container,
      keys,
      phase: 'enter',
      items: enterItems,
      name,
      hook: hooks?.enter,
    });
  }
};

export const scheduleMissingSnaps = <TRenderable>(options: {
  state: TransitionGroupState<TRenderable>;
  keys: readonly PropertyKey[];
  nextLeavingSnapshots: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>;
  stateKey: string;
  host?: LeaveFinalizeHost;
  hook?: TransitionDispatchHook<GroupHookContext>;
  name?: string;
  enabled: boolean;
  getElements: (snapshot: TRenderable) => readonly Element[];
}): Map<PropertyKey, GroupLeavingSnapshot<TRenderable>> => {
  const { state, keys, nextLeavingSnapshots, stateKey, host, hook, name, enabled, getElements } =
    options;
  const activeKeySet = new Set(keys);

  // 这一步是“兜底补录”：即便上层没有显式提供 leaving 集，也能从上一帧状态推导出缺失项。
  state.keys.forEach((key, previousIndex) => {
    if (activeKeySet.has(key) || nextLeavingSnapshots.has(key)) {
      // 当前仍活跃，或已经在本轮被登记为 leaving 的 key，都不需要重复补录。
      return;
    }

    // 旧状态里仍存在、但本轮 keys 已缺失的项，需要补登记为 leaving snapshot。
    scheduleLeavingSnapshot({
      state,
      nextLeavingSnapshots,
      key,
      previousIndex,
      snapshot: state.snapshots[previousIndex] as TRenderable,
      stateKey,
      host,
      hook,
      name,
      enabled,
      getElements,
    });
  });

  return nextLeavingSnapshots;
};
