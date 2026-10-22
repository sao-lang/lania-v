/**
 * 定义 TransitionGroup 运行时使用的核心类型。
 *
 * 这里既描述“状态长什么样”，也描述“运行时之间如何协作”：
 * 1. group state 统一承载当前 keys、可见 snapshots、离场块和离场快照；
 * 2. dom-host / snapshot 两种 runtime 共享一组基础提交协议，再各自扩展差异字段；
 * 3. 组件层最终解析出的 hostMode、hooks、调试摘要也会落到这份类型协议里。
 *
 * 因此它更像是 TransitionGroup 子系统的“总线类型表”，方便 render/runtime/state 三层对齐。
 */
import {
  type DomHostBlockRecord,
  type DomHostOwner,
  type DomHostRemovedBlockHandoff,
} from '../../host/function-component';
import type { TransitionGroupHostMode } from './runtime/host-mode';
import { type TransitionLeaveEntry, type GroupHookContext } from '../registry';
import { type TransitionDispatchHook } from '../host';
import {
  type BaseTransitionCommitKind,
  type BaseTransitionCommitInput,
  type BaseHostFlowRuntime,
  type BaseTransitionDebugSummary,
  type BaseTransitionRuntime,
} from '../runtime';
import type { TransitionPayload } from '@lania-v/shared';
import type {
  DomHostCommitContext,
  GroupPrevCommitContext,
  GroupPrevCommitResult,
  SnapshotCommitContext,
  GroupCommitResult,
} from './render/visible';

// 离场条目在基础 leave entry 上追加 key 与 previousIndex，便于阶段调度定位。
export type GroupLeaveEntry = TransitionLeaveEntry & {
  key: PropertyKey;
  previousIndex: number;
};

export type GroupLeavingBlock = GroupLeaveEntry & {
  block: DomHostBlockRecord;
};

export type GroupLeavingSnapshot<TRenderable> = GroupLeaveEntry & {
  snapshot: TRenderable;
};

export type GroupDomHostState<TRenderable> = {
  container: HTMLElement | null;
  tag: string | undefined;
  domHostAnchor: Comment | null;
  domHostLeaveAnchor: Comment | null;
  activeBlocks: Map<PropertyKey, DomHostBlockRecord>;
  leavingBlocks: Map<PropertyKey, GroupLeavingBlock>;
  leavingSnapshots: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>;
  leaveVersion: number;
};

// 统一状态同时覆盖 snapshot 与 dom-host 两种模式，某些字段在不同模式下可能为空。
export type TransitionGroupState<TRenderable> =
  GroupDomHostState<TRenderable> & {
    keys: PropertyKey[];
    snapshots: TRenderable[];
    owner: DomHostOwner | null;
    activeBlocks: Map<PropertyKey, DomHostBlockRecord>;
  };

export type GroupCommitInput<TRenderable> = BaseTransitionCommitInput<
  readonly TRenderable[]
> & {
  keys: readonly PropertyKey[];
};

export type GroupCommitIntent = BaseTransitionCommitKind;

export type GroupDebugSummary = BaseTransitionDebugSummary & {
  previousKeys: string[];
  previousContainerChildCount: number | null;
  hasOwner: boolean;
  leavingBlockCount: number;
};

export type GroupCommitDebugSummary = GroupDebugSummary & {
  commitIntent: GroupCommitIntent;
  nextKeyCount: number;
};

// prepare 阶段把渲染结果、上一轮状态与调试信息打包，供组件层统一决定如何提交。
export type PreparedGroupCommit<TRenderable> = {
  rendered: TRenderable[];
  keys: readonly PropertyKey[];
  previous: TransitionGroupState<TRenderable> | undefined;
  debugSummary: GroupCommitDebugSummary;
  commitInput: GroupCommitInput<TRenderable>;
};

export type GroupComponentDebugReport = {
  stateKey: string;
} & GroupCommitDebugSummary;

export type PreparedGroupRender<TRenderable> = {
  runtime: TransitionGroupRuntime<TRenderable>;
  prepared: PreparedGroupCommit<TRenderable>;
  debugReport: GroupComponentDebugReport;
};

export type RenderedGroup<TRenderable> = {
  result: TRenderable[] | HTMLElement | null;
  debugReport: GroupComponentDebugReport;
};

export type GroupRuntimeCore<TRenderable> = {
  commit(
    input: GroupCommitInput<TRenderable>
  ): TRenderable[] | HTMLElement | null;
  renderEntries(renderEntries: () => readonly TRenderable[]): TRenderable[];
  resolveCommitIntent(keys: readonly PropertyKey[]): GroupCommitIntent;
  resolveKeys(
    rendered: readonly TRenderable[],
    explicitKeys?: readonly PropertyKey[]
  ): readonly PropertyKey[];
};

export type TransitionGroupRuntime<TRenderable> = BaseTransitionRuntime<
  TransitionGroupState<TRenderable>,
  [readonly PropertyKey[]],
  GroupCommitInput<TRenderable>,
  TRenderable[] | HTMLElement,
  GroupDebugSummary
> &
  GroupRuntimeCore<TRenderable>;

// DOM host runtime 额外维护容器、锚点、owner 以及 block handoff 所需数据。
export type GroupDomHostRuntime<TRenderable> = BaseHostFlowRuntime<
  TransitionGroupState<TRenderable>,
  [readonly PropertyKey[]],
  GroupCommitInput<TRenderable>,
  TRenderable[] | HTMLElement,
  DomHostCommitContext<TRenderable>,
  HTMLElement,
  GroupCommitResult<TRenderable>,
  GroupPrevCommitContext<TRenderable>,
  GroupPrevCommitResult<TRenderable>,
  HTMLElement | null,
  GroupDebugSummary
> &
  GroupRuntimeCore<TRenderable> & {
    createContext(options: {
      keys: readonly PropertyKey[];
      rendered: readonly TRenderable[];
      previous: TransitionGroupState<TRenderable> | undefined;
    }): DomHostCommitContext<TRenderable>;
    container: HTMLElement;
    activeAnchor: Comment;
    leaveAnchor: Comment;
    owner: DomHostOwner;
    activeBlocks: Map<PropertyKey, DomHostBlockRecord>;
    leavingBlocks: Map<PropertyKey, GroupLeavingBlock>;
    leavingSnapshots: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>;
    leaveVersion: number;
    registerLeavingBlock(entry: GroupLeavingBlock): void;
    scheduleLeavingBlock(
      entry: GroupLeavingBlock,
      handoff: DomHostRemovedBlockHandoff
    ): void;
    dispatchPhases(options: {
      keys: readonly PropertyKey[];
      previousKeys?: readonly PropertyKey[];
    }): void;
  };

// snapshot runtime 更关注快照数组与 leaving snapshot 的派发和显示。
export type GroupSnapshotRuntime<TRenderable> = BaseHostFlowRuntime<
  TransitionGroupState<TRenderable>,
  [readonly PropertyKey[]],
  GroupCommitInput<TRenderable>,
  TRenderable[] | HTMLElement,
  SnapshotCommitContext<TRenderable>,
  TRenderable[] | HTMLElement,
  GroupCommitResult<TRenderable>,
  GroupPrevCommitContext<TRenderable>,
  GroupPrevCommitResult<TRenderable>,
  TRenderable[] | HTMLElement | null,
  GroupDebugSummary
> &
  GroupRuntimeCore<TRenderable> & {
    createContext(options: {
      keys: readonly PropertyKey[];
      rendered: readonly TRenderable[];
      previous: TransitionGroupState<TRenderable>;
    }): SnapshotCommitContext<TRenderable>;
    dispatchPhases(options: {
      keys: readonly PropertyKey[];
      snapshots: readonly TRenderable[];
      previousKeys?: readonly PropertyKey[];
    }): void;
    publishState(options: {
      keys: readonly PropertyKey[];
      snapshots: readonly TRenderable[];
      container: HTMLElement | null;
      leavingSnapshots?: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>;
      leaveVersion?: number;
    }): TransitionGroupState<TRenderable>;
    scheduleLeavingSnapshots(options: {
      state: TransitionGroupState<TRenderable>;
      keys: readonly PropertyKey[];
      nextLeavingSnapshots: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>;
    }): Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>;
    scheduleVisibleCommitLeaving(
      context: SnapshotCommitContext<TRenderable>
    ): Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>;
    renderDisplay(options: {
      currentSnapshots: readonly TRenderable[];
      leavingSnapshots: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>;
    }): TRenderable[] | HTMLElement;
  };

export type GroupPhaseItem = {
  key: PropertyKey;
  index: number;
  previousIndex?: number;
};

export type GroupPhaseHooks = {
  appear?: TransitionDispatchHook<GroupHookContext>;
  enter?: TransitionDispatchHook<GroupHookContext>;
  move?: TransitionDispatchHook<GroupHookContext>;
};

// phaseEnabled 允许组件层按需关闭某些阶段，而不必改动 hook 注册本身。
export type GroupPhaseEnabled = Partial<
  Record<'appear' | 'enter' | 'move', boolean>
>;

// 组件层最终解析出的选项会统一收敛成这一结构。
export type ResolvedGroupOptions = {
  payload: TransitionPayload | null;
  hostMode: TransitionGroupHostMode;
  transitionName: string | undefined;
  transitionTag: string | undefined;
  stateKey: string;
  leaveHook: TransitionDispatchHook<GroupHookContext> | undefined;
  leaveEnabled: boolean;
  phaseHooks: GroupPhaseHooks;
  phaseEnabled: GroupPhaseEnabled;
};
