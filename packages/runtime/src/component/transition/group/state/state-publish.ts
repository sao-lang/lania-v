/**
 * 负责发布 TransitionGroup 状态与辅助计算。
 *
 * 这一层是 group render/runtime 与持久状态对象之间的桥梁，主要处理：
 * - 从 rendered 结果推断稳定 key；
 * - 把 DOM host / snapshot 两种运行形态收敛成统一 `TransitionGroupState`；
 * - 维护 leaving blocks / leaving snapshots 的裁剪与版本推进。
 *
 * 这里尽量只做“状态塑形”与“辅助推导”，不掺入具体提交副作用。
 * 换句话说，这里输出的是“下一轮 group runtime 应该如何理解当前结果”的状态快照，
 * 而不是直接操作 DOM 或 dispatch hook。
 */
import {
  type DomHostBlockRecord,
  type DomHostTarget,
} from '../../../host/function-component';
import {
  deleteLeaveEntry,
  resolveLeaveEntry,
} from '../../registry';
import type {
  GroupDomHostRuntime,
  GroupLeaveEntry,
  GroupLeavingBlock,
  GroupLeavingSnapshot,
  TransitionGroupState,
} from '../types';
import {
  createDomInput,
  createGroupState,
  publishGroupState,
  publishGroupStateRaw,
  type GroupCommitPublishInput,
} from './state-runtime';

// 默认 key 会优先读取元素标识，否则退回字符串/数字值本身。
export const resolveGroupKeyIdentity = (value: unknown): PropertyKey | null => {
  if (value instanceof Element) {
    return value.getAttribute('data-key') ?? value.id ?? value.tagName.toLowerCase();
  }

  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
};

export const resolveGroupKeys = <TRenderable>(options: {
  rendered: readonly TRenderable[];
  explicitKeys?: readonly PropertyKey[];
}): readonly PropertyKey[] => {
  const { rendered, explicitKeys } = options;
  if (explicitKeys) {
    // 调用方已显式给 key 时直接信任，避免运行时再次推断导致语义漂移。
    return explicitKeys;
  }

  return rendered.map(
    (entry, index) => resolveGroupKeyIdentity(entry) ?? index
  );
};

export const publishDomHostState = <TRenderable>(options: {
  stateKey: string;
  runtime: GroupDomHostRuntime<TRenderable>;
  transitionTag: string;
  keys: readonly PropertyKey[];
  snapshots: readonly TRenderable[];
}): TransitionGroupState<TRenderable> => {
  const { stateKey, runtime, transitionTag, keys, snapshots } = options;

  return publishDomStateWith({
    stateKey,
    runtime,
    transitionTag,
    input: createDomInput({
      runtime,
      keys,
      snapshots,
    }),
  });
};

// DOM host 状态除了通用字段外，还要额外挂上锚点、owner 与 block 映射。
export const publishDomStateWith = <TRenderable>(options: {
  stateKey: string;
  runtime: GroupDomHostRuntime<TRenderable>;
  transitionTag: string;
  input: GroupCommitPublishInput<TRenderable>;
}): TransitionGroupState<TRenderable> => {
  const { stateKey, runtime, transitionTag, input } = options;
  return publishGroupStateRaw({
    input: {
      stateKey,
      transitionTag,
      ...input,
    },
    internals: {
      domHostAnchor: runtime.activeAnchor,
      domHostLeaveAnchor: runtime.leaveAnchor,
      owner: runtime.owner,
      activeBlocks: runtime.activeBlocks,
      leavingBlocks: runtime.leavingBlocks,
    },
  });
};

export const createDomStatePublisher = <TRenderable>(options: {
  stateKey: string;
  runtime: GroupDomHostRuntime<TRenderable>;
  transitionTag: string;
}): ((input: GroupCommitPublishInput<TRenderable>) => TransitionGroupState<TRenderable>) => {
  const { stateKey, runtime, transitionTag } = options;
  // 这里返回闭包发布器，便于 runtime 在绑定阶段把宿主信息提前封装进去。
  return (input) =>
    publishDomStateWith({
      stateKey,
      runtime,
      transitionTag,
      input,
    });
};

export const createDomRenderTarget = <TRenderable>(
  runtime: Pick<GroupDomHostRuntime<TRenderable>, 'container' | 'activeAnchor' | 'owner'>
): DomHostTarget => {
  return {
    parent: runtime.container,
    anchor: runtime.activeAnchor,
    owner: runtime.owner,
  };
};

export const publishDomBootstrap = <TRenderable>(options: {
  stateKey: string;
  runtime: GroupDomHostRuntime<TRenderable>;
  transitionTag: string;
  keys: readonly PropertyKey[];
  snapshots: readonly TRenderable[];
}): TransitionGroupState<TRenderable> => {
  const { stateKey, runtime, transitionTag, keys, snapshots } = options;
  return publishDomHostState({
    stateKey,
    runtime,
    transitionTag,
    keys,
    snapshots,
  });
};

// snapshot publisher 会先根据 leaving snapshots 回推本轮最大 leaveVersion。
export const createSnapPublisher = <TRenderable>(options: {
  stateKey: string;
  transitionTag?: string;
}): ((input: GroupCommitPublishInput<TRenderable>) => TransitionGroupState<TRenderable>) => {
  const { stateKey, transitionTag } = options;
  return (input) => {
    // 允许调用方只传增量 leaving 集合，版本号由发布阶段统一兜底抬升。
    const resolvedLeaveVersion = input.leavingSnapshots
      ? resolveLeaveVersion(input.leaveVersion ?? 0, input.leavingSnapshots)
      : input.leaveVersion;
    return publishSnapshotState({
      stateKey,
      transitionTag,
      ...input,
      leaveVersion: resolvedLeaveVersion,
    });
  };
};

export const publishSnapshotState = <TRenderable>(options: {
  stateKey: string;
  keys: readonly PropertyKey[];
  snapshots: readonly TRenderable[];
  container: HTMLElement | null;
  transitionTag?: string;
  leavingSnapshots?: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>;
  leaveVersion?: number;
}): TransitionGroupState<TRenderable> => {
  const {
    stateKey,
    keys,
    snapshots,
    container,
    transitionTag,
    leavingSnapshots = new Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>(),
    leaveVersion = 0,
  } = options;

  return publishGroupStateRaw({
    input: {
      // snapshot 模式没有 DOM host internals，因此只发布可持久化的纯状态字段。
      stateKey,
      keys,
      snapshots,
      container,
      transitionTag,
      leavingSnapshots,
      leaveVersion,
    },
    internals: {
      domHostAnchor: null,
      domHostLeaveAnchor: null,
      owner: null,
      activeBlocks: new Map(),
      leavingBlocks: new Map(),
    },
  });
};

export const resolveLeaveVersion = <TRenderable>(
  baseLeaveVersion: number,
  leavingSnapshots: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>
): number => {
  // leaveVersion 既要不小于外部基线，也要覆盖当前 leaving 条目里记录的最大版本。
  return Math.max(
    baseLeaveVersion,
    ...[...leavingSnapshots.values()].map((entry) => entry.leaveVersion),
    0
  );
};

// 当前已重新激活的 key 不应继续停留在 leaving 列表中。
export const pruneLeavingSnapshots = <TRenderable>(
  leavingSnapshots: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>,
  activeKeys: readonly PropertyKey[]
): Map<PropertyKey, GroupLeavingSnapshot<TRenderable>> => {
  if (leavingSnapshots.size === 0) {
    return leavingSnapshots;
  }

  const activeKeySet = new Set(activeKeys);
  let nextSnapshots: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>> | null = null;

  leavingSnapshots.forEach((_entry, key) => {
    if (!activeKeySet.has(key)) {
      return;
    }

    // 同 key 一旦重新回到活跃集合，就不应继续保留旧 leaving snapshot。
    nextSnapshots ??= new Map(leavingSnapshots);
    nextSnapshots.delete(key);
  });

  return nextSnapshots ?? leavingSnapshots;
};

export const resolveLeavingEntry = <TEntry extends GroupLeaveEntry>(
  entries: Map<PropertyKey, TEntry>,
  key: PropertyKey,
  leaveVersion: number
): TEntry | null => {
  // 薄封装一层 registry 能力，保持 group state 模块对外 API 一致。
  return resolveLeaveEntry(entries, key, leaveVersion);
};

export const deleteLeavingEntry = <TEntry extends GroupLeaveEntry>(
  entries: Map<PropertyKey, TEntry>,
  key: PropertyKey,
  leaveVersion: number
): { entry: TEntry | null; nextEntries: Map<PropertyKey, TEntry> | null } => {
  return deleteLeaveEntry(entries, key, leaveVersion);
};

export const createLeavingBlock = (
  key: PropertyKey,
  block: DomHostBlockRecord,
  previousIndex: number,
  leaveVersion: number
): GroupLeavingBlock => {
  return {
    key,
    block,
    previousIndex,
    leaveVersion,
  };
};

export const createLeavingSnapshot = <TRenderable>(
  key: PropertyKey,
  snapshot: TRenderable,
  previousIndex: number,
  leaveVersion: number
): GroupLeavingSnapshot<TRenderable> => {
  return {
    key,
    snapshot,
    previousIndex,
    leaveVersion,
  };
};

export const pruneLeavingState = <
  TState,
  TRenderable,
>(
  current: TState,
  activeKeys: readonly PropertyKey[],
  selectLeavingSnapshots: (
    state: TState
  ) => Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>,
  assignLeavingSnapshots: (
    state: TState,
    leavingSnapshots: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>
  ) => TState
): TState => {
  const currentSnapshots = selectLeavingSnapshots(current);
  const nextLeavingSnapshots = pruneLeavingSnapshots(currentSnapshots, activeKeys);
  if (nextLeavingSnapshots === currentSnapshots) {
    // 没有发生实际裁剪时复用原状态引用，减少无意义重建。
    return current;
  }

  return assignLeavingSnapshots(current, nextLeavingSnapshots);
};

// 旧 snapshot 可能属于上一轮挂载的子树：宿主卸载后这些节点已经脱离文档，
// 继续复用会把游离节点重新塞回 DOM。这里只复用仍然“活着”的快照。
const isReusableSnapshot = (snapshot: unknown): boolean => {
  if (
    snapshot &&
    typeof snapshot === 'object' &&
    typeof (snapshot as { isConnected?: unknown }).isConnected === 'boolean'
  ) {
    return (snapshot as { isConnected: boolean }).isConnected;
  }

  return true;
};

// 对同 key 的条目尽量复用 previous snapshot，减少无谓元素替换。
// 这对保留 DOM/过渡上下文尤为重要，因为许多宿主逻辑依赖 snapshot 身份稳定。
export const resolveSnapshots = <TRenderable>(options: {
  keys: readonly PropertyKey[];
  renderedSnapshots: readonly TRenderable[];
  previousKeys: readonly PropertyKey[];
  previousSnapshots: readonly TRenderable[];
}): TRenderable[] => {
  const { keys, renderedSnapshots, previousKeys, previousSnapshots } = options;

  return keys.map((key, index) => {
    const previousIndex = previousKeys.indexOf(key);
    const previousSnapshot =
      previousIndex === -1 ? undefined : previousSnapshots[previousIndex];
    // 只要 key 稳定且旧节点仍在文档里，就优先复用旧 snapshot 身份，让依赖引用稳定的 host/runtime 得到更少扰动。
    return previousSnapshot !== undefined && isReusableSnapshot(previousSnapshot)
      ? previousSnapshot
      : renderedSnapshots[index]!;
  });
};
