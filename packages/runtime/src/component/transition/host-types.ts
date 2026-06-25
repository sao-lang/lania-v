/**
 * 定义单节点 Transition 运行时对外暴露的类型。
 *
 * 包括 hook 调度签名、commit 输入输出、调试报告以及具体 runtime 形状。
 */
import type { TransitionPayload } from '@lania-v/shared';
import type {
  TransitionHookContextShape,
  LeaveFinalizeHost,
  TransitionPhase,
  TransitionState,
} from './registry';
import type {
  BaseTransitionCommitInput,
  BaseTransitionDebugSummary,
  BaseHostFlowRuntime,
  BasePrevContext,
  BasePrevResult,
  BaseCommitResult,
} from './runtime';

// 所有可调度 hook 至少都会收到当前阶段名。
export type TransitionDispatchContext = {
  phase: TransitionPhase;
};

export type TransitionDispatchHook<TContext extends TransitionDispatchContext> = (
  element: Element,
  context: TContext
) => void | Promise<void>;

export type TransitionDispatchOptions = {
  defer?: boolean;
  onSettled?: () => void;
};

export type NamedTransitionPhaseHooks = {
  appear?: TransitionDispatchHook<TransitionHookContextShape>;
  enter?: TransitionDispatchHook<TransitionHookContextShape>;
  leave?: TransitionDispatchHook<TransitionHookContextShape>;
};

export type NamedTransitionPhaseEnabled = Partial<Record<'appear' | 'enter' | 'leave', boolean>>;

// 在基础 host flow runtime 上补充 `commit()` 这一层可见/离场分派入口。
export type TransitionRuntime<TRenderable> = BaseHostFlowRuntime<
  TransitionState<TRenderable>,
  [],
  TRenderable,
  TRenderable,
  TransitionCommitContext<TRenderable>,
  TRenderable,
  TransitionCommitResult<TRenderable>,
  TransitionPrevCommitContext<TRenderable>,
  TransitionPrevCommitResult<TRenderable>,
  TRenderable | null
> & {
  commit(input: TransitionCommitInput<TRenderable>): TRenderable | null;
};

export type TransitionCommitInput<TRenderable> = BaseTransitionCommitInput<TRenderable> & {
  visible: boolean;
};

export type ResolvedTransitionOptions = {
  payload: TransitionPayload | null;
  transitionName: string | undefined;
  stateKey: string;
  hooks: NamedTransitionPhaseHooks;
  enabled: NamedTransitionPhaseEnabled;
};

export type TransitionDebugReport = {
  stateKey: string;
  visible: boolean;
} & BaseTransitionDebugSummary;

export type PreparedTransitionCommit<TRenderable> = {
  commitInput: TransitionCommitInput<TRenderable>;
  debugReport: TransitionDebugReport;
};

export type PreparedTransitionRender<TRenderable> = {
  runtime: TransitionRuntime<TRenderable>;
  prepared: PreparedTransitionCommit<TRenderable>;
  debugReport: TransitionDebugReport;
};

export type RenderedTransition<TRenderable> = {
  result: TRenderable | null;
  debugReport: TransitionDebugReport;
};

// 可见提交上下文会同时带上本次渲染值、previous 快照与提取出的元素集合。
export type TransitionCommitContext<TRenderable> = {
  rendered: TRenderable;
  previous: TransitionState<TRenderable> | undefined;
  elements: readonly Element[];
};

export type TransitionCommitResult<TRenderable> =
  BaseCommitResult<TransitionState<TRenderable>>;

export type TransitionPrevCommitContext<TRenderable> = BasePrevContext<
  TransitionState<TRenderable> | undefined
>;

export type TransitionPrevCommitResult<TRenderable> =
  BasePrevResult<TRenderable | null>;

export type TransitionRenderOptions<TRenderable> = {
  payload: TransitionPayload;
  visible: boolean;
  rendered: TRenderable;
  host?: LeaveFinalizeHost;
  getElements: (snapshot: TRenderable) => readonly Element[];
};
