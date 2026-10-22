/**
 * 绑定 `TransitionGroup` 在不同 host 模式下的提交阶段逻辑。
 *
 * 这个文件承接 runtime scaffold 与具体 host 实现之间的“中间层职责”：
 * 1. 生成 snapshot / dom-host 两类阶段调度器；
 * 2. 负责 visible / leaving / hidden 提交所需的上下文拼装与显示结果回放；
 * 3. 把按 `stateKey` 读取 previous state、再按 `kind` 分发的通用流程收敛成复用函数。
 *
 * 因为 snapshot 与 dom-host 共享很多“提交外壳”，这里主要做的是流程编排而不是具体渲染。
 */
import { type BasePrevApplier } from '../../runtime';
import { getTransitionGroupState } from '../state/store';
import {
  createDomInput,
  pruneLeavingSnapshots,
  resolveSnapshots,
} from '../state/state';
import {
  createDisplayInput,
  createLeavingCommitInput,
  createCommitPublishContext,
  createCommitPublishInput,
  type GroupDisplayInput,
  type DomHostCommitContext,
  type GroupPrevCommitContext,
  type GroupPrevCommitKind,
  type GroupPrevCommitResult,
  type SnapshotCommitState,
  type SnapshotCommitContext,
  renderDomResult,
} from '../render/visible';
import {
  type GroupDomHostRuntime,
  type GroupPhaseEnabled,
  type GroupPhaseHooks,
  type GroupSnapshotRuntime,
  type TransitionGroupState,
} from '../types';
import {
  dispatchSnapshotPhases,
  scheduleDomHostPhases,
} from '../render/phases';

// snapshot 阶段调度器把 key/snapshot 对齐信息交给 phase dispatcher。
export const createSnapPhases = <TRenderable>(options: {
  name?: string;
  hooks?: GroupPhaseHooks;
  enabled?: GroupPhaseEnabled;
  getElements: (snapshot: TRenderable) => readonly Element[];
}): ((input: {
  keys: readonly PropertyKey[];
  snapshots: readonly TRenderable[];
  previousKeys?: readonly PropertyKey[];
}) => void) => {
  const { name, hooks, enabled, getElements } = options;
  return ({ keys, snapshots, previousKeys }) => {
    dispatchSnapshotPhases({
      keys,
      snapshots,
      previousKeys,
      name,
      hooks,
      enabled,
      getElements,
    });
  };
};

export const createDomPhases = (options: {
  stateKey: string;
  container: HTMLElement;
  name?: string;
  hooks?: GroupPhaseHooks;
  enabled?: GroupPhaseEnabled;
}): ((input: {
  keys: readonly PropertyKey[];
  previousKeys?: readonly PropertyKey[];
}) => void) => {
  const { stateKey, container, name, hooks, enabled } = options;
  return ({ keys, previousKeys }) => {
    scheduleDomHostPhases({
      stateKey,
      container,
      keys,
      previousKeys,
      name,
      hooks,
      enabled,
    });
  };
};

export const renderSnapPrev = <TRenderable>(options: {
  runtime: Pick<GroupSnapshotRuntime<TRenderable>, 'renderDisplay'>;
  context: GroupPrevCommitContext<TRenderable>;
  publishResult: GroupPrevCommitResult<TRenderable>;
}): TRenderable[] | HTMLElement => {
  const { runtime, context, publishResult } = options;
  return runtime.renderDisplay(
    createSnapPrevDisplay({
      context,
      state: publishResult.value,
    })
  );
};

// DOM host 的 previous 渲染没有额外 display 结构，直接复用现成容器即可。
export const renderDomPrev = <TRenderable>(options: {
  runtime: Pick<GroupDomHostRuntime<TRenderable>, 'container'>;
}): HTMLElement => {
  return options.runtime.container;
};

// 通过当前 keys 与 previous state 计算本次可见快照和待离场快照集合。
export const resolveSnapshotCommitState = <TRenderable>(options: {
  keys: readonly PropertyKey[];
  renderedSnapshots: readonly TRenderable[];
  previous: TransitionGroupState<TRenderable>;
}): SnapshotCommitState<TRenderable> => {
  const { keys, renderedSnapshots, previous } = options;
  const currentSnapshots = resolveSnapshots({
    keys,
    renderedSnapshots,
    previousKeys: previous.keys,
    previousSnapshots: previous.snapshots,
  });
  const nextLeavingSnapshots = pruneLeavingSnapshots(
    new Map(previous.leavingSnapshots),
    keys
  );

  return {
    currentSnapshots,
    nextLeavingSnapshots,
  };
};

export const createSnapDisplay = <TRenderable>(
  context: SnapshotCommitContext<TRenderable>
): GroupDisplayInput<TRenderable> => {
  return createDisplayInput({
    currentSnapshots: context.state.currentSnapshots,
    leavingSnapshots: context.state.nextLeavingSnapshots,
  });
};

export const createSnapPrevDisplay = <TRenderable>(options: {
  context: GroupPrevCommitContext<TRenderable>;
  state: Pick<
    TransitionGroupState<TRenderable>,
    'snapshots' | 'leavingSnapshots'
  >;
}): GroupDisplayInput<TRenderable> => {
  const { context, state } = options;
  return createDisplayInput({
    // hidden 时还会回放上一轮可见快照；leaving 时则只渲染离场集合。
    currentSnapshots: context.kind === 'leaving' ? [] : state.snapshots,
    leavingSnapshots: state.leavingSnapshots,
  });
};

export const createSnapLeavingDisplay = <TRenderable>(
  state: Pick<TransitionGroupState<TRenderable>, 'leavingSnapshots'>
): GroupDisplayInput<TRenderable> => {
  return createDisplayInput({
    currentSnapshots: [],
    leavingSnapshots: state.leavingSnapshots,
  });
};

export const commitSnapshotLeaving = <TRenderable>(options: {
  runtime: Pick<
    GroupSnapshotRuntime<TRenderable>,
    | 'getPrevious'
    | 'scheduleLeavingSnapshots'
    | 'publishState'
    | 'renderDisplay'
  >;
}): TRenderable[] | HTMLElement | null => {
  const { runtime } = options;
  const previous = runtime.getPrevious();
  if (!previous) {
    return null;
  }

  // leaving 提交时不再接受新 keys，只把旧 state 里尚需离场的快照继续交给调度器处理。
  const nextLeavingSnapshots = runtime.scheduleLeavingSnapshots({
    state: previous,
    keys: [],
    nextLeavingSnapshots: new Map(previous.leavingSnapshots),
  });
  const next = runtime.publishState(
    createLeavingCommitInput({
      previous,
      leavingSnapshots: nextLeavingSnapshots,
    })
  );
  return runtime.renderDisplay(createSnapLeavingDisplay(next));
};

export const createSnapCommit = <TRenderable>(options: {
  keys: readonly PropertyKey[];
  renderedSnapshots: readonly TRenderable[];
  previous: TransitionGroupState<TRenderable>;
}): SnapshotCommitContext<TRenderable> => {
  const { keys, renderedSnapshots, previous } = options;
  const state = resolveSnapshotCommitState({
    keys,
    renderedSnapshots,
    previous,
  });
  return createCommitPublishContext({
    keys,
    previous,
    // publishStateInput 会在后续统一交给 state publisher，避免 commit 阶段重复拼装。
    publishStateInput: createCommitPublishInput({
      keys,
      snapshots: state.currentSnapshots,
      container: previous.container,
      leavingSnapshots: state.nextLeavingSnapshots,
      leaveVersion: previous.leaveVersion,
    }),
    extra: {
      state,
    },
  });
};

// dom-host commit 会把“空 previous 状态”折叠成 undefined，避免误判为需要复用旧状态。
// 对 DOM host 来说，“有一个空 state”与“压根还没建立上一轮上下文”是两种不同含义。
export const createDomCommit = <TRenderable>(options: {
  keys: readonly PropertyKey[];
  previous: TransitionGroupState<TRenderable> | undefined;
  runtime: GroupDomHostRuntime<TRenderable>;
  rendered: readonly TRenderable[];
}): DomHostCommitContext<TRenderable> => {
  const { keys, previous, runtime, rendered } = options;
  const normalizedPrevious =
    previous &&
    previous.keys.length === 0 &&
    previous.leavingBlocks.size === 0 &&
    previous.leavingSnapshots.size === 0
      ? undefined
      : previous;
  // 这里故意把“空对象 previous”折叠掉，避免 DOM host 误以为上一轮已经建立过可复用上下文。
  return createCommitPublishContext({
    keys,
    previous: normalizedPrevious,
    publishStateInput: createDomInput({
      runtime,
      keys,
      snapshots: keys.map(() => null as TRenderable),
    }),
    extra: {
      rendered,
    },
  });
};

// previous 提交统一通过 stateKey 读取共享状态，再按 kind 分发给 runtime。
// 这样 hidden / leaving 两条路径都不必各自重复一遍“先读 store、再判空”的样板逻辑。
export const commitPrevByKind = <TRenderable, TResult>(options: {
  stateKey: string;
  kind: GroupPrevCommitKind;
  commitPreviousContext(context: GroupPrevCommitContext<TRenderable>): TResult;
}): TResult | null => {
  const { stateKey, kind, commitPreviousContext } = options;
  const previous = getTransitionGroupState<TRenderable>(stateKey);
  if (!previous) {
    // previous commit 是幂等入口：没有旧状态时直接返回 null，而不是把缺状态当异常。
    return null;
  }

  return commitPreviousContext({
    previous,
    kind,
  });
};

export const commitPrevForStateKey = <TRenderable, TResult>(options: {
  stateKey: string;
  kind: GroupPrevCommitKind;
  runtime: {
    commitPreviousContext(
      context: GroupPrevCommitContext<TRenderable>
    ): TResult;
  };
}): TResult | null => {
  const { stateKey, kind, runtime } = options;
  return commitPrevByKind<TRenderable, TResult>({
    stateKey,
    kind,
    commitPreviousContext: (context) => runtime.commitPreviousContext(context),
  });
};

// 绑定 snapshot runtime 的显示结果渲染与 leaving/previous 提交入口。
export const bindSnapDisplay = <TRenderable>(options: {
  runtime: Pick<
    GroupSnapshotRuntime<TRenderable>,
    | 'getPrevious'
    | 'scheduleLeavingSnapshots'
    | 'publishState'
    | 'renderDisplay'
    | 'renderVisibleCommitResult'
    | 'renderPreviousCommitResult'
    | 'commitLeaving'
  >;
  renderDisplay(
    input: GroupDisplayInput<TRenderable>
  ): TRenderable[] | HTMLElement;
}): void => {
  const { runtime, renderDisplay } = options;
  runtime.renderDisplay = renderDisplay;
  runtime.commitLeaving = () => {
    // leaving 的提交入口单独绑定，保证 snapshot runtime 能在可见结果之外延后处理离场项。
    return commitSnapshotLeaving({
      runtime,
    });
  };
  runtime.renderVisibleCommitResult = (context, _publishResult) => {
    return renderDisplay(createSnapDisplay(context));
  };
  runtime.renderPreviousCommitResult = (context, publishResult) => {
    return renderDisplay(
      createSnapPrevDisplay({
        context,
        state: publishResult.value,
      })
    );
  };
};

export const bindDomHostRenderRuntime = <TRenderable>(options: {
  stateKey: string;
  runtime: Pick<
    GroupDomHostRuntime<TRenderable>,
    | 'container'
    | 'activeAnchor'
    | 'activeBlocks'
    | 'renderVisibleCommitResult'
    | 'renderPreviousCommitResult'
    | 'commitLeaving'
  > & {
    commitPreviousContext(
      context: GroupPrevCommitContext<TRenderable>
    ): HTMLElement | null;
  };
}): void => {
  const { stateKey, runtime } = options;
  runtime.renderVisibleCommitResult = (context, _publishResult) => {
    // visible 路径只负责把最终 DOM 呈现到容器；状态发布已在上游完成。
    return renderDomResult({
      runtime,
      context,
    });
  };
  runtime.renderPreviousCommitResult = () => {
    // previous DOM 渲染不重新走 publish，而是直接基于 store 中缓存的上轮状态恢复。
    return renderDomPrev({
      runtime,
    });
  };
  runtime.commitLeaving = () => {
    return commitPrevForStateKey({
      stateKey,
      kind: 'leaving',
      runtime,
    });
  };
};

// 把 hidden 提交绑定到 runtime 上，形成与 visible / leaving 对称的 previous commit 入口。
export const bindPrevCommitRuntime = <TRenderable, TResult>(options: {
  stateKey: string;
  runtime: BasePrevApplier<
    GroupPrevCommitContext<TRenderable>,
    GroupPrevCommitResult<TRenderable>,
    TResult
  > & {
    commitHidden?(): TResult | null;
    commitPreviousContext(
      context: GroupPrevCommitContext<TRenderable>
    ): TResult;
  };
}): void => {
  const { stateKey, runtime } = options;
  runtime.commitHidden = () => {
    return commitPrevByKind<TRenderable, TResult>({
      stateKey,
      kind: 'hidden',
      commitPreviousContext: (context) =>
        runtime.commitPreviousContext(context),
    });
  };
};
