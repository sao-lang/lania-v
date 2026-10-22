/**
 * 构建 TransitionGroup 的 snapshot 模式运行时。
 *
 * snapshot 模式与 DOM host 模式的区别在于：
 * - 不维护独立的 block 容器或锚点；
 * - 当前可见内容直接表现为 snapshot 数组；
 * - 离场元素也以 snapshot 集合形式保留，等待 leave hook 完成后再清理。
 *
 * 因此这个文件重点负责两件事：先给出一份可运行的默认 snapshot runtime，
 * 再把状态发布、显示渲染、离场调度与提交阶段按需绑定进去。
 */
import type { TransitionDispatchHook } from '../../host';
import type { GroupHookContext, LeaveFinalizeHost } from '../../registry';
import { createBaseCommitResult } from '../../runtime';
import {
  createGroupState,
  createSnapPublisher,
  resolveGroupKeys,
} from '../state/state';
import {
  bindSnapDisplay,
  createSnapPhases,
  createSnapCommit,
} from './commit-runtime';
import {
  commitInitialSnapshotVisible,
  createCommitPublishInput,
  createPrevCommitResult,
  dispatchSnapCommits,
  scheduleSnapshotCommitLeaving,
  type SnapshotCommitContext,
} from '../render/visible';
import { createSnapshotDisplayRenderer } from '../render/display';
import { scheduleMissingSnaps } from '../render/phases';
import { resolveRenderedEntries } from './dom-host-runtime';
import {
  bindGroupHostRuntime,
  createGroupRuntimeScaffold,
} from './host-scaffold';
import type {
  GroupLeavingSnapshot,
  GroupPhaseEnabled,
  GroupPhaseHooks,
  GroupSnapshotRuntime,
} from '../types';

// 先创建一份可工作的默认 runtime，再由 bindSnapshotRuntime 补齐真实实现。
export const createSnapshotRuntime = <
  TRenderable,
>(): GroupSnapshotRuntime<TRenderable> => {
  return {
    ...createGroupRuntimeScaffold<
      TRenderable,
      SnapshotCommitContext<TRenderable>,
      TRenderable[] | HTMLElement,
      TRenderable[] | HTMLElement | null
    >({
      resolveKeys(rendered, explicitKeys) {
        return resolveGroupKeys({ rendered, explicitKeys });
      },
      resolveRenderedEntries,
    }),
    commitLeaving(): TRenderable[] | HTMLElement | null {
      return null;
    },
    publishPreviousCommitState(context) {
      return createPrevCommitResult(context.kind, context.previous);
    },
    renderPreviousCommitResult(context, _publishResult) {
      return context.kind === 'hidden' ? null : [];
    },
    commitHidden(): TRenderable[] | HTMLElement | null {
      return null;
    },
    dispatchPhases(_options) {},
    dispatchVisibleCommitPhases(_context) {},
    prepareVisibleCommit(_context) {},
    publishVisibleCommitState(context) {
      return createBaseCommitResult(context.previous);
    },
    publishState({
      keys,
      snapshots,
      container,
      leavingSnapshots,
      leaveVersion,
    }) {
      // 默认实现只发布最朴素的 snapshot state，绑定后再替换成带 tag/stateKey 的正式发布器。
      return createGroupState({
        keys: [...keys],
        snapshots: [...snapshots],
        container: container ?? null,
        tag: undefined,
        domHostAnchor: null,
        domHostLeaveAnchor: null,
        owner: null,
        activeBlocks: new Map(),
        leavingBlocks: new Map(),
        leavingSnapshots:
          leavingSnapshots ??
          new Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>(),
        leaveVersion: leaveVersion ?? 0,
      });
    },
    scheduleLeavingSnapshots({ nextLeavingSnapshots }) {
      // 未绑定 leave hook 时，默认直接沿用上游算好的 leaving 集合。
      return nextLeavingSnapshots;
    },
    scheduleVisibleCommitLeaving(context) {
      return context.state.nextLeavingSnapshots;
    },
    renderVisibleCommitResult(context, _publishResult) {
      return [...context.state.currentSnapshots];
    },
    renderDisplay({ currentSnapshots }) {
      return [...currentSnapshots];
    },
    // 没有 previous 时手动构造一份空状态，保证后续 commit 逻辑无需分支。
    createContext({ keys, rendered, previous }) {
      if (!previous) {
        // 首次进入 snapshot runtime 时，补一份“空 previous”让下游统一走增量提交流程。
        return {
          keys,
          previous: createGroupState({
            keys: [],
            snapshots: [],
            container: null,
            tag: undefined,
            domHostAnchor: null,
            domHostLeaveAnchor: null,
            owner: null,
            activeBlocks: new Map(),
            leavingBlocks: new Map(),
            leavingSnapshots: new Map(),
            leaveVersion: 0,
          }),
          previousKeys: [],
          publishStateInput: createCommitPublishInput({
            keys,
            snapshots: [...rendered],
            container: null,
            leavingSnapshots: new Map(),
            leaveVersion: 0,
          }),
          state: {
            currentSnapshots: [...rendered],
            nextLeavingSnapshots: new Map(),
          },
        };
      }
      // 已有 previous 时交给专门的 snapshot commit 构造器，复用 key/snapshot 对齐逻辑。
      return createSnapCommit({
        keys,
        renderedSnapshots: rendered,
        previous,
      });
    },
  };
};

// 绑定状态发布、显示渲染、离场快照调度和可见提交流程。
export const bindSnapshotRuntime = <TRenderable>(options: {
  stateKey: string;
  transitionTag?: string;
  runtime: GroupSnapshotRuntime<TRenderable>;
  name?: string;
  phaseHooks?: GroupPhaseHooks;
  phaseEnabled?: GroupPhaseEnabled;
  leaveHook?: TransitionDispatchHook<GroupHookContext>;
  leaveEnabled: boolean;
  host?: LeaveFinalizeHost;
  getElements: (snapshot: TRenderable) => readonly Element[];
}): GroupSnapshotRuntime<TRenderable> => {
  const {
    stateKey,
    transitionTag,
    runtime,
    name,
    phaseHooks,
    phaseEnabled,
    leaveHook,
    leaveEnabled,
    host,
    getElements,
  } = options;
  const publishSnapshotState = createSnapPublisher<TRenderable>({
    stateKey,
    transitionTag,
  });
  const renderSnapshotDisplay = createSnapshotDisplayRenderer<TRenderable>({
    stateKey,
    transitionTag,
  });
  const dispatchSnapshotPhases = createSnapPhases<TRenderable>({
    name,
    hooks: phaseHooks,
    enabled: phaseEnabled,
    getElements,
  });

  runtime.dispatchPhases = dispatchSnapshotPhases;
  runtime.publishState = ({
    keys,
    snapshots,
    container,
    leavingSnapshots,
    leaveVersion,
  }) => {
    return publishSnapshotState({
      keys,
      snapshots,
      container,
      leavingSnapshots,
      leaveVersion,
    });
  };
  // 缺失的旧快照会在这里登记为 leaving snapshot，随后交给 hook 调度异步清理。
  runtime.scheduleLeavingSnapshots = ({
    state,
    keys,
    nextLeavingSnapshots,
  }) => {
    return scheduleMissingSnaps({
      state,
      keys,
      nextLeavingSnapshots,
      stateKey,
      host,
      hook: leaveHook,
      name,
      enabled: leaveEnabled,
      getElements,
    });
  };
  runtime.scheduleVisibleCommitLeaving = (context) => {
    // visible commit 阶段只负责把上下文重新转接给 leaving 调度器。
    return runtime.scheduleLeavingSnapshots({
      state: context.previous,
      keys: context.keys,
      nextLeavingSnapshots: context.state.nextLeavingSnapshots,
    });
  };
  bindSnapDisplay({
    runtime,
    renderDisplay: ({ currentSnapshots, leavingSnapshots }) => {
      return renderSnapshotDisplay({
        currentSnapshots,
        leavingSnapshots,
      });
    },
  });
  bindGroupHostRuntime({
    stateKey,
    runtime,
    publishState: (input) => runtime.publishState(input),
    dispatchVisibleCommitPhases: (context) => {
      dispatchSnapCommits({
        runtime,
        context,
      });
    },
    prepareVisibleCommit: (context) => {
      // snapshot 模式在 visible commit 前先登记本轮需要保留的 leaving snapshots。
      scheduleSnapshotCommitLeaving({
        runtime,
        context,
      });
    },
    commitInitial: ({ keys, rendered }) => {
      return commitInitialSnapshotVisible({
        runtime,
        keys,
        rendered,
        transitionTag,
      });
    },
  });
  return runtime;
};

export const bootstrapSnapshotRuntime = <TRenderable>(options: {
  stateKey: string;
  transitionTag?: string;
  name?: string;
  phaseHooks?: GroupPhaseHooks;
  phaseEnabled?: GroupPhaseEnabled;
  leaveHook?: TransitionDispatchHook<GroupHookContext>;
  leaveEnabled: boolean;
  host?: LeaveFinalizeHost;
  getElements: (snapshot: TRenderable) => readonly Element[];
}): GroupSnapshotRuntime<TRenderable> => {
  const {
    stateKey,
    transitionTag,
    name,
    phaseHooks,
    phaseEnabled,
    leaveHook,
    leaveEnabled,
    host,
    getElements,
  } = options;
  return bindSnapshotRuntime({
    stateKey,
    transitionTag,
    runtime: createSnapshotRuntime<TRenderable>(),
    name,
    phaseHooks,
    phaseEnabled,
    leaveHook,
    leaveEnabled,
    host,
    getElements,
  });
};
