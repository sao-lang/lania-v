/**
 * 收敛 `TransitionGroup` 可见提交阶段的上下文构造与结果渲染。
 *
 * 这个文件更偏“拼装层”，负责把 group commit 里反复出现的几类对象统一建模出来：
 * 1. visible / previous 两条提交流程都会复用的 context 与 publish input；
 * 2. snapshot 模式与 dom-host 模式共享的 state publisher 绑定器；
 * 3. display 渲染前需要的 current / leaving 快照聚合结果。
 *
 * 这样不同 host runtime 只需要关注自己的阶段调度与渲染细节，不必重复拼接这些通用数据结构。
 */
import {
  applyBasePrevContext,
  applyBaseCommitContext,
  createBaseCommitResult,
  type BasePrevApplier,
  type BasePrevContext,
  type BaseTransitionPreviousCommitKind,
  type BasePrevResult,
  type BaseCommitApplier,
  type BaseCommitResult,
} from '../../runtime';
import {
  pruneLeavingSnapshots,
  type GroupCommitPublishInput,
  resolveSnapshots,
} from '../state/state';
import {
  type GroupCommitInput,
  type GroupDomHostRuntime,
  type GroupLeavingSnapshot,
  type GroupSnapshotRuntime,
  type TransitionGroupState,
} from '../types';
import {
  syncDomHostStaticEntries,
  wrapDisplayWithTag,
} from './display';

export type SnapshotCommitState<TRenderable> = {
  currentSnapshots: TRenderable[];
  nextLeavingSnapshots: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>;
};

export type GroupDisplayInput<TRenderable> = {
  currentSnapshots: readonly TRenderable[];
  leavingSnapshots: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>;
};

export type GroupPrevCommitKind = Extract<
  BaseTransitionPreviousCommitKind,
  'leaving' | 'hidden'
>;

export type GroupPrevCommitContext<TRenderable> =
  BasePrevContext<
    TransitionGroupState<TRenderable>,
    GroupPrevCommitKind
  >;

export type GroupPrevCommitResult<TRenderable> =
  BasePrevResult<
    TransitionGroupState<TRenderable>,
    GroupPrevCommitKind
  >;

export const createPrevCommitResult = <TRenderable>(
  kind: GroupPrevCommitKind,
  value: TransitionGroupState<TRenderable>
): GroupPrevCommitResult<TRenderable> => {
  return {
    kind,
    value,
  };
};

export type GroupCommitContext<TPrevious> = {
  keys: readonly PropertyKey[];
  previous: TPrevious;
  previousKeys?: readonly PropertyKey[];
};

export type GroupCommitPublishContext<TPrevious, TRenderable> =
  GroupCommitContext<TPrevious> & {
    publishStateInput: GroupCommitPublishInput<TRenderable>;
  };

export type DomHostCommitContext<TRenderable> =
  GroupCommitPublishContext<TransitionGroupState<TRenderable> | undefined, TRenderable> & {
    rendered: readonly TRenderable[];
  };

export type SnapshotCommitContext<TRenderable> =
  GroupCommitPublishContext<TransitionGroupState<TRenderable>, TRenderable> & {
  state: SnapshotCommitState<TRenderable>;
};

export type GroupCommitResult<TRenderable> =
  BaseCommitResult<TransitionGroupState<TRenderable>>;

// commit context 统一附带当前 keys 与 previous keys，供后续阶段复用。
export const createCommitContext = <
  TPrevious extends { keys: readonly PropertyKey[] } | undefined,
>(options: {
  keys: readonly PropertyKey[];
  previous: TPrevious;
}): GroupCommitContext<TPrevious> => {
  const { keys, previous } = options;
  return {
    keys,
    previous,
    previousKeys: previous?.keys,
  };
};

// 在基础 context 之上挂上 publishStateInput，并允许拼接额外运行时数据。
export const createCommitPublishContext = <
  TPrevious extends { keys: readonly PropertyKey[] } | undefined,
  TRenderable,
  TExtra extends object = {},
>(options: {
  keys: readonly PropertyKey[];
  previous: TPrevious;
  publishStateInput: GroupCommitPublishInput<TRenderable>;
  extra?: TExtra;
}): GroupCommitPublishContext<TPrevious, TRenderable> & TExtra => {
  const { keys, previous, publishStateInput, extra } = options;
  return {
    ...createCommitContext({
      keys,
      previous,
    }),
    publishStateInput,
    ...(extra ?? ({} as TExtra)),
  };
};

export const createCommitPublishInput = <TRenderable>(options: {
  keys: readonly PropertyKey[];
  snapshots: readonly TRenderable[];
  container: HTMLElement | null;
  leavingSnapshots?: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>;
  leaveVersion?: number;
}): GroupCommitPublishInput<TRenderable> => {
  const { keys, snapshots, container, leavingSnapshots, leaveVersion } = options;
  return {
    keys,
    snapshots,
    container,
    leavingSnapshots,
    leaveVersion,
  };
};

export const createDisplayInput = <TRenderable>(options: {
  currentSnapshots: readonly TRenderable[];
  leavingSnapshots: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>;
}): GroupDisplayInput<TRenderable> => {
  const { currentSnapshots, leavingSnapshots } = options;
  return {
    currentSnapshots,
    leavingSnapshots,
  };
};

export const createPrevCommitInput = <TRenderable>(
  context: GroupPrevCommitContext<TRenderable>
): GroupCommitPublishInput<TRenderable> => {
  return {
    // previous commit 不再产出新的可见快照，只保留原容器与可能仍在离场的快照集合。
    keys: [],
    snapshots: [],
    container: context.previous.container,
    leavingSnapshots: context.kind === 'leaving' ? context.previous.leavingSnapshots : new Map(),
    leaveVersion: context.previous.leaveVersion,
  };
};

export const createLeavingCommitInput = <TRenderable>(options: {
  previous: Pick<TransitionGroupState<TRenderable>, 'container' | 'leaveVersion'>;
  leavingSnapshots: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>;
}): GroupCommitPublishInput<TRenderable> => {
  const { previous, leavingSnapshots } = options;
  return {
    keys: [],
    snapshots: [],
    container: previous.container,
    leavingSnapshots,
    leaveVersion: previous.leaveVersion,
  };
};

export const publishPrevCommitResult = <TRenderable>(options: {
  context: GroupPrevCommitContext<TRenderable>;
  publishState(
    input: GroupCommitPublishInput<TRenderable>
  ): TransitionGroupState<TRenderable>;
}): GroupPrevCommitResult<TRenderable> => {
  const { context, publishState } = options;
  return createPrevCommitResult(
    context.kind,
    publishState(createPrevCommitInput(context))
  );
};

export const createCommitStatePublisher = <TRenderable>(options: {
  publishState(
    input: GroupCommitPublishInput<TRenderable>
  ): TransitionGroupState<TRenderable>;
}): (<TContext extends { publishStateInput: GroupCommitPublishInput<TRenderable> }>(
  context: TContext
) => GroupCommitResult<TRenderable>) => {
  const { publishState } = options;
  return (context) => {
    return createBaseCommitResult(
      // publishStateInput 已在 createContext 阶段准备好，这里只负责把它落成统一的 base result。
      publishState(context.publishStateInput)
    );
  };
};

export const bindCommitStateRuntime = <
  TRenderable,
  TContext extends { publishStateInput: GroupCommitPublishInput<TRenderable> },
>(options: {
  runtime: {
    publishVisibleCommitState?(
      context: TContext
    ): GroupCommitResult<TRenderable>;
  };
  publishState(
    input: GroupCommitPublishInput<TRenderable>
  ): TransitionGroupState<TRenderable>;
}): void => {
  const { runtime, publishState } = options;
  runtime.publishVisibleCommitState = createCommitStatePublisher({
    publishState,
  });
};

export const createPrevStatePublisher = <TRenderable>(options: {
  publishState(
    input: GroupCommitPublishInput<TRenderable>
  ): TransitionGroupState<TRenderable>;
}): ((
  context: GroupPrevCommitContext<TRenderable>
) => GroupPrevCommitResult<TRenderable>) => {
  const { publishState } = options;
  return (context) => {
    return publishPrevCommitResult({
      context,
      publishState,
    });
  };
};

export const bindPrevCommitStateRuntime = <TRenderable, TResult>(options: {
  runtime: BasePrevApplier<
    GroupPrevCommitContext<TRenderable>,
    GroupPrevCommitResult<TRenderable>,
    TResult
  >;
  publishState(
    input: GroupCommitPublishInput<TRenderable>
  ): TransitionGroupState<TRenderable>;
}): void => {
  const { runtime, publishState } = options;
  runtime.publishPreviousCommitState = createPrevStatePublisher({
    publishState,
  });
};

// 这层绑定器把“上一轮状态解析 -> context 组装 -> 阶段派发 -> 结果渲染”串成统一主流程。
// 把 visible commit 的阶段调度、上下文构造与初次提交策略绑定到 runtime。
// 首次提交允许走 commitInitial，是为了让 runtime 在“没有 previous state”时保留专门的引导逻辑。
export const bindCommitFlowRuntime = <
  TRenderable,
  TPrevious,
  TContext,
  TResult extends TRenderable[] | HTMLElement = TRenderable[] | HTMLElement,
>(options: {
  runtime: {
    resolvePrevious(keys: readonly PropertyKey[]): TPrevious | undefined;
    commitVisibleContext(context: TContext): TResult;
    commitVisible?(input: GroupCommitInput<TRenderable>): TResult;
    dispatchVisibleCommitPhases?(context: TContext): void;
    prepareVisibleCommit?(context: TContext): void;
  };
  createContext(options: {
    keys: readonly PropertyKey[];
    rendered: readonly TRenderable[];
    previous: TPrevious;
  }): TContext;
  dispatchVisibleCommitPhases(context: TContext): void;
  prepareVisibleCommit?(context: TContext): void;
  commitInitial?(input: GroupCommitInput<TRenderable>): TResult;
}): void => {
  const { runtime, createContext, dispatchVisibleCommitPhases, prepareVisibleCommit, commitInitial } =
    options;
  runtime.dispatchVisibleCommitPhases = dispatchVisibleCommitPhases;
  if (prepareVisibleCommit) {
    runtime.prepareVisibleCommit = prepareVisibleCommit;
  }
  runtime.commitVisible = ({ keys, rendered }) => {
    const previous = runtime.resolvePrevious(keys);
    if (previous === undefined && commitInitial) {
      return commitInitial({
        keys,
        rendered,
      });
    }
    const context = createContext({
      keys,
      rendered,
      previous: previous as TPrevious,
    });
    return runtime.commitVisibleContext(context);
  };
};

// snapshot 模式首次可见提交需要先派发阶段，再选择是否包一层 transitionTag 容器。
// 这里同时把首帧 state 发布出去，确保后续 leaving/hidden 可以基于同一份 group state 接续执行。
export const commitInitialSnapshotVisible = <TRenderable>(options: {
  runtime: Pick<
    GroupSnapshotRuntime<TRenderable>,
    'dispatchPhases' | 'publishState'
  >;
  keys: readonly PropertyKey[];
  rendered: readonly TRenderable[];
  transitionTag?: string;
}): TRenderable[] | HTMLElement => {
  const { runtime, keys, rendered, transitionTag } = options;
  runtime.dispatchPhases({
    keys,
    snapshots: rendered,
  });
  const wrapped = wrapDisplayWithTag(transitionTag, rendered);
  runtime.publishState({
    keys,
    snapshots: rendered,
    container: wrapped instanceof HTMLElement ? wrapped : null,
  });
  return wrapped ?? [...rendered];
};

export const dispatchSnapCommits = <TRenderable>(options: {
  runtime: Pick<GroupSnapshotRuntime<TRenderable>, 'dispatchPhases'>;
  context: SnapshotCommitContext<TRenderable>;
}): void => {
  const { runtime, context } = options;
  runtime.dispatchPhases({
    keys: context.keys,
    snapshots: context.state.currentSnapshots,
    previousKeys: context.previous.keys,
  });
};

export const scheduleSnapshotCommitLeaving = <TRenderable>(options: {
  runtime: Pick<GroupSnapshotRuntime<TRenderable>, 'scheduleLeavingSnapshots'>;
  context: SnapshotCommitContext<TRenderable>;
}): Map<PropertyKey, GroupLeavingSnapshot<TRenderable>> => {
  const { runtime, context } = options;
  // visible commit 先算出基础 leaving 集合，再交给 runtime 注入 phase hook 或异步策略。
  return runtime.scheduleLeavingSnapshots({
    state: context.previous,
    keys: context.keys,
    nextLeavingSnapshots: context.state.nextLeavingSnapshots,
  });
};

export const renderSnapResult = <TRenderable>(options: {
  runtime: Pick<GroupSnapshotRuntime<TRenderable>, 'renderDisplay'>;
  context: SnapshotCommitContext<TRenderable>;
}): TRenderable[] | HTMLElement => {
  const { runtime, context } = options;
  return runtime.renderDisplay(
    createDisplayInput({
      currentSnapshots: context.state.currentSnapshots,
      leavingSnapshots: context.state.nextLeavingSnapshots,
    })
  );
};

export const dispatchDomCommits = <TRenderable>(options: {
  runtime: Pick<GroupDomHostRuntime<TRenderable>, 'dispatchPhases'>;
  context: DomHostCommitContext<TRenderable>;
}): void => {
  const { runtime, context } = options;
  runtime.dispatchPhases({
    keys: context.keys,
    previousKeys: context.previousKeys,
  });
};

// dom-host 模式若没有活跃 block，需要把静态渲染结果同步回容器。
// 一旦 activeBlocks 非空，说明真实节点已经由 block 级 DOM host 自己接管，这里就不再覆盖容器内容。
export const renderDomResult = <TRenderable>(options: {
  runtime: Pick<
    GroupDomHostRuntime<TRenderable>,
    'container' | 'activeAnchor' | 'activeBlocks'
  >;
  context: DomHostCommitContext<TRenderable>;
}): HTMLElement => {
  const { runtime, context } = options;
  if (runtime.activeBlocks.size === 0) {
    syncDomHostStaticEntries({
      container: runtime.container,
      activeAnchor: runtime.activeAnchor,
      rendered: context.rendered,
    });
  }
  return runtime.container;
};
