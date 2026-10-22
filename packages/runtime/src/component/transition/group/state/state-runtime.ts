/**
 * TransitionGroup 状态运行时适配层。
 *
 * 这里把 TransitionGroup 在多次 commit 之间要共享的状态操作集中收口，职责主要有三类：
 * - 把 runtime 当前持有的 DOM/leave/snapshot 结构整理成统一 state 并发布到 store；
 * - 读取 previous state、裁剪过期 leaving 内容，并生成调试摘要；
 * - 根据当前 keys 与 previous 状态推断 commit intent，再把这些能力绑定回 runtime。
 *
 * 它并不直接做动画调度或 DOM 写入，而是充当 commit/render 与 store 之间的“状态翻译层”，
 * 让上层只围绕 keys/snapshots 工作，底层则稳定复用 previous/intent/stateKey 机制。
 */
import {
  type DomHostBlockRecord,
  type DomHostOwner,
} from '../../../host/function-component';
import {} from '../../registry';
import {
  applyBasePrevContext,
  applyBaseCommitContext,
  type BasePrevApplier,
  type BaseCommitApplier,
  createBaseTransitionDebugSummary,
  resolveCommitKind,
} from '../../runtime';
import { getTransitionGroupState, setTransitionGroupState } from './store';
import type {
  GroupCommitDebugSummary,
  GroupCommitInput,
  GroupCommitIntent,
  GroupDebugSummary,
  GroupDomHostRuntime,
  GroupLeavingBlock,
  GroupLeavingSnapshot,
  TransitionGroupRuntime,
  TransitionGroupState,
} from '../types';
import {
  createCommitPublishInput,
  type GroupPrevCommitContext,
  type GroupPrevCommitResult,
  type GroupCommitResult,
} from '../render/visible';
import { pruneLeavingState } from './state-publish';

// 创建一份完整的 TransitionGroupState，供 registry/store 和 runtime 双方共享。
export const createGroupState = <TRenderable>(options: {
  keys: PropertyKey[];
  snapshots: TRenderable[];
  container: HTMLElement | null;
  tag: string | undefined;
  domHostAnchor: Comment | null;
  domHostLeaveAnchor: Comment | null;
  owner: DomHostOwner | null;
  activeBlocks: Map<PropertyKey, DomHostBlockRecord>;
  leavingBlocks: Map<PropertyKey, GroupLeavingBlock>;
  leavingSnapshots: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>;
  leaveVersion: number;
}): TransitionGroupState<TRenderable> => {
  const {
    keys,
    snapshots,
    container,
    tag,
    domHostAnchor,
    domHostLeaveAnchor,
    owner,
    activeBlocks,
    leavingBlocks,
    leavingSnapshots,
    leaveVersion,
  } = options;

  return {
    keys,
    snapshots,
    container,
    tag,
    domHostAnchor,
    domHostLeaveAnchor,
    owner,
    activeBlocks,
    leavingBlocks,
    leavingSnapshots,
    leaveVersion,
  };
};

export type GroupStateInput<TRenderable> = {
  stateKey: string;
  keys: readonly PropertyKey[];
  snapshots: readonly TRenderable[];
  container: HTMLElement | null;
  transitionTag?: string;
  leavingSnapshots?: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>;
  leaveVersion?: number;
};

export type GroupStateInternals = {
  domHostAnchor: Comment | null;
  domHostLeaveAnchor: Comment | null;
  owner: DomHostOwner | null;
  activeBlocks: Map<PropertyKey, DomHostBlockRecord>;
  leavingBlocks: Map<PropertyKey, GroupLeavingBlock>;
};

// 从 DOM host runtime 当前持有的结构，快速构造一份可发布的 group state。
export const createDomState = <TRenderable>(options: {
  runtime: Pick<
    GroupDomHostRuntime<TRenderable>,
    | 'container'
    | 'activeAnchor'
    | 'leaveAnchor'
    | 'owner'
    | 'activeBlocks'
    | 'leavingBlocks'
    | 'leavingSnapshots'
    | 'leaveVersion'
  >;
  transitionTag?: string;
  keys?: readonly PropertyKey[];
  snapshots?: readonly TRenderable[];
}): TransitionGroupState<TRenderable> => {
  const { runtime, transitionTag, keys = [], snapshots = [] } = options;
  return createGroupState({
    keys: [...keys],
    snapshots: [...snapshots],
    container: runtime.container,
    tag: transitionTag,
    domHostAnchor: runtime.activeAnchor,
    domHostLeaveAnchor: runtime.leaveAnchor,
    owner: runtime.owner,
    activeBlocks: runtime.activeBlocks,
    leavingBlocks: runtime.leavingBlocks,
    leavingSnapshots: runtime.leavingSnapshots,
    leaveVersion: runtime.leaveVersion,
  });
};

export type GroupCommitPublishInput<TRenderable> = Omit<
  GroupStateInput<TRenderable>,
  'stateKey' | 'transitionTag'
>;

// 提取 DOM host commit 发布时真正需要的最小输入集。
export const createDomInput = <TRenderable>(options: {
  runtime: Pick<
    GroupDomHostRuntime<TRenderable>,
    'container' | 'leavingSnapshots' | 'leaveVersion'
  >;
  keys: readonly PropertyKey[];
  snapshots: readonly TRenderable[];
}): GroupCommitPublishInput<TRenderable> => {
  const { runtime, keys, snapshots } = options;
  return createCommitPublishInput({
    keys,
    snapshots,
    container: runtime.container,
    leavingSnapshots: runtime.leavingSnapshots,
    leaveVersion: runtime.leaveVersion,
  });
};

// 用显式传入的 internals + input 直接发布 group state，适合作为低层桥接函数复用。
export const publishGroupStateRaw = <TRenderable>(options: {
  input: GroupStateInput<TRenderable>;
  internals: GroupStateInternals;
}): TransitionGroupState<TRenderable> => {
  const { input, internals } = options;
  const {
    stateKey,
    keys,
    snapshots,
    container,
    transitionTag,
    leavingSnapshots = new Map<
      PropertyKey,
      GroupLeavingSnapshot<TRenderable>
    >(),
    leaveVersion = 0,
  } = input;
  const {
    domHostAnchor,
    domHostLeaveAnchor,
    owner,
    activeBlocks,
    leavingBlocks,
  } = internals;

  // 这里统一拷贝 keys/snapshots，避免上层沿用可变数组时把 store 中的 previous state 一并污染。
  return publishGroupState(
    stateKey,
    createGroupState({
      keys: [...keys],
      snapshots: [...snapshots],
      container,
      tag: transitionTag,
      domHostAnchor,
      domHostLeaveAnchor,
      owner,
      activeBlocks,
      leavingBlocks,
      leavingSnapshots,
      leaveVersion,
    })
  );
};

// 对 store 的最薄封装，便于上层在同一处替换或追加调试逻辑。
export const publishGroupState = <TRenderable>(
  stateKey: string,
  state: TransitionGroupState<TRenderable>
): TransitionGroupState<TRenderable> => {
  return setTransitionGroupState(stateKey, state);
};

// 读取 previous state 时会先裁剪过期 leavingSnapshots，避免历史离场内容无限残留。
export const resolvePrevState = <TRenderable>(options: {
  stateKey: string;
  keys: readonly PropertyKey[];
  previous?: TransitionGroupState<TRenderable>;
}): TransitionGroupState<TRenderable> | undefined => {
  const { stateKey, keys, previous } = options;
  if (!previous) {
    return undefined;
  }

  // 进入新一轮 keys 之前先裁掉已经不再需要保留的 leaving 快照，避免 previous state 越积越大。
  const resolvedPrevious = pruneLeavingState(
    previous,
    keys,
    (state: TransitionGroupState<TRenderable>) => state.leavingSnapshots,
    (
      state: TransitionGroupState<TRenderable>,
      leavingSnapshots: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>
    ) => ({
      ...state,
      leavingSnapshots,
    })
  );

  if (resolvedPrevious !== previous) {
    // 裁剪结果有变化时，立即把更干净的 previous state 回写到 store。
    publishGroupState(stateKey, resolvedPrevious);
  }

  return resolvedPrevious;
};

// 生成调试摘要时，重点关心 previous 是否可见、是否仍有 leaving 内容、是否绑定 owner/container。
export const summarizePrevState = <TRenderable>(
  previous: TransitionGroupState<TRenderable> | undefined
): GroupDebugSummary => {
  return {
    ...createBaseTransitionDebugSummary({
      hasPrevious: Boolean(previous),
      previousVisible: previous ? previous.keys.length > 0 : null,
      previousAppeared: previous ? previous.keys.length > 0 : null,
      previousLeaving: previous
        ? previous.leavingBlocks.size > 0 || previous.leavingSnapshots.size > 0
        : null,
      hasSnapshot: Boolean(
        previous?.snapshots.length || previous?.leavingSnapshots.size
      ),
    }),
    previousKeys: previous?.keys.map((key) => String(key)) ?? [],
    previousContainerChildCount: previous?.container?.childNodes.length ?? null,
    hasOwner: Boolean(previous?.owner),
    leavingBlockCount: previous?.leavingBlocks.size ?? 0,
  };
};

export const createCommitDebugSummary = <TRenderable>(options: {
  previous: TransitionGroupState<TRenderable> | undefined;
  keys: readonly PropertyKey[];
}): GroupCommitDebugSummary => {
  const { previous, keys } = options;
  return {
    ...summarizePrevState(previous),
    commitIntent: resolveCommitIntent({
      keys,
      previous,
    }),
    nextKeyCount: keys.length,
  };
};

// 只要 previous 里还有 leavingSnapshots 或 leavingBlocks，就视为存在离场内容。
export const hasLeavingContent = <TRenderable>(
  previous: TransitionGroupState<TRenderable> | undefined
): boolean => {
  if (!previous) {
    return false;
  }

  return previous.leavingSnapshots.size > 0 || previous.leavingBlocks.size > 0;
};

// 根据“当前 keys + previous 状态”解析本次是 visible、leaving、retainedLeaving 还是 hidden commit。
export const resolveCommitIntent = <TRenderable>(options: {
  keys: readonly PropertyKey[];
  previous: TransitionGroupState<TRenderable> | undefined;
}): GroupCommitIntent => {
  const { keys, previous } = options;
  // commit kind 只依赖四个布尔语义：当前是否可见、过去是否可见、是否仍有离场内容、是否存在任何快照。
  return resolveCommitKind({
    visible: keys.length > 0,
    previousVisible: (previous?.keys.length ?? 0) > 0,
    previousLeaving: hasLeavingContent(previous),
    hasSnapshot: Boolean(
      previous &&
      (previous.snapshots.length > 0 ||
        previous.leavingSnapshots.size > 0 ||
        previous.leavingBlocks.size > 0)
    ),
  });
};

// 通过 stateKey 从 store 里拿到当前组件对应的 previous state。
export const readPrevForKeys = <TRenderable>(options: {
  stateKey: string;
  keys: readonly PropertyKey[];
}): TransitionGroupState<TRenderable> | undefined => {
  const { stateKey, keys } = options;
  return resolvePrevState({
    stateKey,
    keys,
    previous: getTransitionGroupState<TRenderable>(stateKey),
  });
};

// 便捷调试入口：直接对某个 stateKey 生成 previous 摘要。
export const summarizePrevForStateKey = <TRenderable>(
  stateKey: string
): GroupDebugSummary => {
  return summarizePrevState(getTransitionGroupState<TRenderable>(stateKey));
};

// 不直接读取 runtime 上的 previous，而是统一经由 stateKey 解析 intent。
export const resolveIntentForKey = <TRenderable>(options: {
  stateKey: string;
  keys: readonly PropertyKey[];
}): GroupCommitIntent => {
  const { stateKey, keys } = options;
  return resolveCommitIntent({
    keys,
    previous: readPrevForKeys<TRenderable>({
      stateKey,
      keys,
    }),
  });
};

// 根据 intent 把 commit 分发到 visible / leaving / hidden 三条提交路径。
export const commitByIntent = <TRenderable>(options: {
  runtime: Pick<
    TransitionGroupRuntime<TRenderable>,
    'resolveCommitIntent' | 'commitVisible' | 'commitLeaving' | 'commitHidden'
  >;
  input: GroupCommitInput<TRenderable>;
}): TRenderable[] | HTMLElement | null => {
  const { runtime, input } = options;
  // 先统一解析 intent，再分发到三条提交路径，避免各 runtime 自己重复判断 visible/leaving/hidden。
  const kind = runtime.resolveCommitIntent(input.keys);
  switch (kind) {
    case 'visible':
      return runtime.commitVisible(input);
    case 'leaving':
    case 'retainedLeaving':
      return runtime.commitLeaving?.() ?? null;
    case 'hidden':
    default:
      return runtime.commitHidden?.() ?? null;
  }
};

// 为某个固定 stateKey 生成一组 runtime 绑定方法，避免每次手写 store 查询逻辑。
export const createStateKeyBindings = <TRenderable>(stateKey: string) => {
  return {
    getPrevious(): TransitionGroupState<TRenderable> | undefined {
      return getTransitionGroupState<TRenderable>(stateKey);
    },
    summarizePrevious(): GroupDebugSummary {
      return summarizePrevForStateKey<TRenderable>(stateKey);
    },
    resolveCommitIntent(keys: readonly PropertyKey[]): GroupCommitIntent {
      return resolveIntentForKey<TRenderable>({
        stateKey,
        keys,
      });
    },
    resolvePrevious(
      keys: readonly PropertyKey[]
    ): TransitionGroupState<TRenderable> | undefined {
      return readPrevForKeys({
        stateKey,
        keys,
      });
    },
  } satisfies Pick<
    TransitionGroupRuntime<TRenderable>,
    | 'getPrevious'
    | 'summarizePrevious'
    | 'resolveCommitIntent'
    | 'resolvePrevious'
  >;
};

// 占位实现：没有真正 stateKey 时，返回一组始终“无 previous / hidden”的默认绑定。
export const createPlaceholderKeys = <TRenderable>() => {
  return {
    getPrevious(): TransitionGroupState<TRenderable> | undefined {
      return undefined;
    },
    summarizePrevious(): GroupDebugSummary {
      return summarizePrevState(this.getPrevious());
    },
    resolveCommitIntent(_keys: readonly PropertyKey[]): GroupCommitIntent {
      return 'hidden';
    },
    resolvePrevious(
      _keys: readonly PropertyKey[]
    ): TransitionGroupState<TRenderable> | undefined {
      return undefined;
    },
  } satisfies Pick<
    TransitionGroupRuntime<TRenderable>,
    | 'getPrevious'
    | 'summarizePrevious'
    | 'resolveCommitIntent'
    | 'resolvePrevious'
  >;
};

export type GroupPlaceholderCommitRuntime<
  TRenderable,
  TVisibleContext,
  TVisibleResult extends TRenderable[] | HTMLElement,
  TPreviousResult extends TRenderable[] | HTMLElement | null,
> = {
  commitVisibleContext(context: TVisibleContext): TVisibleResult;
  commitPreviousContext(
    context: GroupPrevCommitContext<TRenderable>
  ): TPreviousResult;
};

// 为基础 commit applier 生成过渡组占位实现，供具体 runtime 在不关心状态细节时直接复用。
export const createPlaceholderCommit = <
  TRenderable,
  TVisibleContext,
  TVisibleResult extends TRenderable[] | HTMLElement,
  TPreviousResult extends TRenderable[] | HTMLElement | null,
>() => {
  return {
    commitVisibleContext(
      this: BaseCommitApplier<
        TVisibleContext,
        TVisibleResult,
        GroupCommitResult<TRenderable>
      >,
      context: TVisibleContext
    ): TVisibleResult {
      return applyBaseCommitContext(this, context);
    },
    commitPreviousContext(
      this: BasePrevApplier<
        GroupPrevCommitContext<TRenderable>,
        GroupPrevCommitResult<TRenderable>,
        TPreviousResult
      >,
      context: GroupPrevCommitContext<TRenderable>
    ): TPreviousResult {
      return applyBasePrevContext(this, context);
    },
  } satisfies GroupPlaceholderCommitRuntime<
    TRenderable,
    TVisibleContext,
    TVisibleResult,
    TPreviousResult
  >;
};

// 把某个 stateKey 对应的状态读取能力直接挂到 runtime 实例上。
export const bindStateKeyRuntime = <TRenderable>(options: {
  stateKey: string;
  runtime: Pick<
    TransitionGroupRuntime<TRenderable>,
    | 'getPrevious'
    | 'summarizePrevious'
    | 'resolveCommitIntent'
    | 'resolvePrevious'
  >;
}): void => {
  const { stateKey, runtime } = options;
  const bindings = createStateKeyBindings<TRenderable>(stateKey);
  runtime.getPrevious = bindings.getPrevious;
  runtime.summarizePrevious = bindings.summarizePrevious;
  runtime.resolveCommitIntent = bindings.resolveCommitIntent;
  runtime.resolvePrevious = bindings.resolvePrevious;
};
