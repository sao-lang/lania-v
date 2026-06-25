/**
 * 过渡运行时的基础提交协议与类型骨架。
 *
 * 该文件不绑定具体 DOM 或组件实现，而是抽象出一套“本次提交该走哪条分支”的通用协议：
 * - visible：当前内容应直接显示；
 * - leaving：从可见切到不可见，但仍需要保留 snapshot 做离场；
 * - retainedLeaving：上一轮已经进入 leaving，本轮继续复用离场快照；
 * - hidden：既不显示当前内容，也不再保留离场快照。
 *
 * 单节点 `Transition` 和列表 `TransitionGroup` 都会复用这里的类型与辅助函数，
 * 在各自宿主层补充“如何派发 hooks、如何发布状态、如何产出最终渲染结果”。
 */
export type TransitionCommitProtocol<TVisibleInput, TOutput> = {
  commitVisible(input: TVisibleInput): TOutput;
  commitLeaving?(): TOutput | null;
  commitRetainedLeaving?(): TOutput | null;
  commitHidden?(): TOutput | null;
};

export type BaseTransitionDebugSummary = {
  hasPrevious: boolean;
  previousVisible: boolean | null;
  previousAppeared: boolean | null;
  previousLeaving: boolean | null;
  hasSnapshot: boolean;
};

export type BaseDebugInput = {
  hasPrevious: boolean;
  previousVisible?: boolean | null;
  previousAppeared?: boolean | null;
  previousLeaving?: boolean | null;
  hasSnapshot?: boolean;
};

export const createBaseTransitionDebugSummary = (
  input: BaseDebugInput
): BaseTransitionDebugSummary => {
  const { hasPrevious, previousVisible, previousAppeared, previousLeaving, hasSnapshot } = input;
  // 缺失值统一收敛成 null / false，方便调试面板稳定展示。
  return {
    hasPrevious,
    previousVisible: previousVisible ?? null,
    previousAppeared: previousAppeared ?? null,
    previousLeaving: previousLeaving ?? null,
    hasSnapshot: hasSnapshot ?? false,
  };
};

export type BasePrevDebugRuntime<
  TPrevious,
  TResolveArgs extends unknown[],
  TSummary extends BaseTransitionDebugSummary = BaseTransitionDebugSummary,
> = {
  getPrevious(): TPrevious | undefined;
  resolvePrevious(...args: TResolveArgs): TPrevious | undefined;
  summarizePrevious(): TSummary;
};

export type BaseTransitionRuntime<
  TPrevious,
  TResolveArgs extends unknown[],
  TVisibleInput,
  TOutput,
  TSummary extends BaseTransitionDebugSummary = BaseTransitionDebugSummary,
> = TransitionCommitProtocol<TVisibleInput, TOutput> &
  BasePrevDebugRuntime<TPrevious, TResolveArgs, TSummary>;

export type BaseTransitionCommitInput<TRendered> = {
  rendered: TRendered;
};

export type BaseCommitResult<TValue> = {
  value: TValue;
};

export const createBaseCommitResult = <TValue>(
  value: TValue
): BaseCommitResult<TValue> => {
  // 基础 commit 结果统一包一层对象，方便上层在不改签名的前提下扩展 publish 信息。
  return {
    value,
  };
};

export type BaseCommitApplier<TContext, TResult, TPublishResult = unknown> = {
  prepareVisibleCommit?(context: TContext): void;
  dispatchVisibleCommitPhases(context: TContext): void;
  publishVisibleCommitState(context: TContext): TPublishResult;
  renderVisibleCommitResult(context: TContext, publishResult: TPublishResult): TResult;
};

export type BaseCommitRuntime<TContext, TResult, TPublishResult = unknown> =
  BaseCommitApplier<TContext, TResult, TPublishResult> & {
    commitVisibleContext(context: TContext): TResult;
  };

export const applyBaseCommitContext = <
  TContext,
  TResult,
  TPublishResult = unknown,
>(
  runtime: BaseCommitApplier<TContext, TResult, TPublishResult>,
  context: TContext
): TResult => {
  // visible 提交遵循 prepare -> dispatch -> publish -> render 的固定顺序。
  runtime.prepareVisibleCommit?.(context);
  runtime.dispatchVisibleCommitPhases(context);
  const publishResult = runtime.publishVisibleCommitState(context);
  return runtime.renderVisibleCommitResult(context, publishResult);
};

export type BaseHiddenCommitKind = 'leaving' | 'retainedLeaving' | 'hidden';

export type BaseTransitionCommitKind = 'visible' | BaseHiddenCommitKind;

export const resolveCommitKind = (options: {
  visible: boolean;
  previousVisible: boolean;
  previousLeaving: boolean;
  hasSnapshot: boolean;
}): BaseTransitionCommitKind => {
  const { visible, ...nonVisibleOptions } = options;
  if (visible) {
    return 'visible';
  }

  // 仅在当前不可见时，再根据 previous 状态决定是否进入 leaving/hidden 分支。
  return resolveHiddenKind(nonVisibleOptions);
};

export const resolveHiddenKind = (options: {
  previousVisible: boolean;
  previousLeaving: boolean;
  hasSnapshot: boolean;
}): BaseHiddenCommitKind => {
  const { previousVisible, previousLeaving, hasSnapshot } = options;
  if (hasSnapshot && previousVisible) {
    // 刚从 visible 切到 hidden，优先进入 leaving，让旧快照完成离场。
    return 'leaving';
  }
  if (hasSnapshot && previousLeaving) {
    // 已在离场中的快照继续保留，不重复创建新的 leaving 任务。
    return 'retainedLeaving';
  }
  return 'hidden';
};

export type BaseTransitionPreviousCommitKind = BaseHiddenCommitKind;

export type BasePrevContextShape<
  TKind extends BaseTransitionPreviousCommitKind = BaseTransitionPreviousCommitKind,
> = {
  kind: TKind;
};

export type BasePrevContext<
  TPrevious,
  TKind extends BaseTransitionPreviousCommitKind = BaseTransitionPreviousCommitKind,
> = BasePrevContextShape<TKind> & {
  previous: TPrevious;
};

export type BasePrevResult<
  TValue,
  TKind extends BaseTransitionPreviousCommitKind = BaseTransitionPreviousCommitKind,
> = {
  kind: TKind;
  value: TValue;
};

export type BasePrevApplier<
  TContext extends BasePrevContextShape,
  TPublishResult extends BasePrevResult<unknown, TContext['kind']>,
  TResult,
> = {
  preparePreviousCommit?(context: TContext): void;
  publishPreviousCommitState(context: TContext): TPublishResult;
  renderPreviousCommitResult(context: TContext, publishResult: TPublishResult): TResult;
};

export type BasePrevRuntime<
  TContext extends BasePrevContextShape,
  TPublishResult extends BasePrevResult<unknown, TContext['kind']>,
  TResult,
> =
  BasePrevApplier<TContext, TPublishResult, TResult> & {
    commitPreviousContext(context: TContext): TResult;
  };

export type BaseHostDebugRuntime<
  TPrevious,
  TResolveArgs extends unknown[],
  TSummary extends BaseTransitionDebugSummary = BaseTransitionDebugSummary,
> = BasePrevDebugRuntime<TPrevious, TResolveArgs, TSummary>;

export type BaseHostCommitRuntime<
  TVisibleContext,
  TVisibleResult,
  TVisiblePublishResult extends BaseCommitResult<unknown>,
  TPreviousContext extends BasePrevContextShape,
  TPreviousPublishResult extends BasePrevResult<
    unknown,
    TPreviousContext['kind']
  >,
  TPreviousResult,
> = BaseCommitRuntime<TVisibleContext, TVisibleResult, TVisiblePublishResult> &
  BasePrevRuntime<TPreviousContext, TPreviousPublishResult, TPreviousResult>;

export type BaseHostRuntime<
  TPrevious,
  TResolveArgs extends unknown[],
  TVisibleContext,
  TVisibleResult,
  TVisiblePublishResult extends BaseCommitResult<unknown>,
  TPreviousContext extends BasePrevContextShape,
  TPreviousPublishResult extends BasePrevResult<
    unknown,
    TPreviousContext['kind']
  >,
  TPreviousResult,
  TSummary extends BaseTransitionDebugSummary = BaseTransitionDebugSummary,
> = BaseHostDebugRuntime<TPrevious, TResolveArgs, TSummary> &
  BaseHostCommitRuntime<
    TVisibleContext,
    TVisibleResult,
    TVisiblePublishResult,
    TPreviousContext,
    TPreviousPublishResult,
    TPreviousResult
  >;

export type BaseHostFlowRuntime<
  TPrevious,
  TResolveArgs extends unknown[],
  TVisibleInput,
  TOutput,
  TVisibleContext,
  TVisibleResult,
  TVisiblePublishResult extends BaseCommitResult<unknown>,
  TPreviousContext extends BasePrevContextShape,
  TPreviousPublishResult extends BasePrevResult<
    unknown,
    TPreviousContext['kind']
  >,
  TPreviousResult,
  TSummary extends BaseTransitionDebugSummary = BaseTransitionDebugSummary,
> = BaseTransitionRuntime<TPrevious, TResolveArgs, TVisibleInput, TOutput, TSummary> &
  BaseHostCommitRuntime<
    TVisibleContext,
    TVisibleResult,
    TVisiblePublishResult,
    TPreviousContext,
    TPreviousPublishResult,
    TPreviousResult
  >;

export const applyBasePrevContext = <
  TContext extends BasePrevContextShape,
  TPublishResult extends BasePrevResult<unknown, TContext['kind']>,
  TResult,
>(
  runtime: BasePrevApplier<TContext, TPublishResult, TResult>,
  context: TContext
): TResult => {
  // previous 分支不需要派发 visible hooks，只保留 prepare -> publish -> render。
  runtime.preparePreviousCommit?.(context);
  const publishResult = runtime.publishPreviousCommitState(context);
  return runtime.renderPreviousCommitResult(context, publishResult);
};
