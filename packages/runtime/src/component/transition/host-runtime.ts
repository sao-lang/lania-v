/**
 * 实现单节点 `Transition` 的运行时提交流程。
 *
 * 这个文件处在“编译期 payload”和“宿主提交流程”之间，主要承担四件事：
 * 1. 校验并解析共享 payload，整理出运行时真正关心的 `name / key / hooks / enabled`；
 * 2. 根据上一帧共享状态与当前 `visible`，决定本次 commit 属于 visible / leaving / hidden 哪一类；
 * 3. 在 visible、leave 两个方向上调度命名阶段 hook，并把收尾动作接到 leave settle 回调上；
 * 4. 把最终快照、离场状态和调试摘要统一写回 transition registry，供下一次提交继续复用。
 *
 * 整体上它本身不持有实例级状态，所有可持续状态都落在共享 registry 中。
 * 可以把它理解成一个“无状态 commit 协调器”：
 * - 输入是当前 render 结果、可见性和编译期 payload；
 * - 中间做的是阶段判定、hook 调度和 registry 状态切换；
 * - 输出则是这次提交后真正要继续保留的 snapshot。
 */
import type { TransitionPayload } from '@lania-v/shared';
import {
  beginTransitionLeaving,
  createDebugSummary,
  createFinalizeHandler,
  finalizeLeaving,
  getTransitionState,
  retainTransitionLeavingState,
  setTransitionExitedState,
  setTransitionVisibleState,
  type TransitionHookContextShape,
  type LeaveFinalizeHost,
  type TransitionLeavingEntry,
  type TransitionState,
} from './registry';
import {
  applyBasePrevContext,
  applyBaseCommitContext,
  createBaseCommitResult,
  resolveCommitKind,
} from './runtime';
import { dispatchNamedHooks } from './host-hooks';
import type {
  NamedTransitionPhaseEnabled,
  NamedTransitionPhaseHooks,
  PreparedTransitionCommit,
  PreparedTransitionRender,
  RenderedTransition,
  ResolvedTransitionOptions,
  TransitionCommitInput,
  TransitionDebugReport,
  TransitionDispatchHook,
  TransitionPrevCommitContext,
  TransitionRuntime,
  TransitionCommitContext,
} from './host-types';

// 只接受 Transition 组件产出的 payload，避免别的 boundary payload 误入。
const readRuntimePayload = (
  payload: TransitionPayload | undefined
): TransitionPayload | null => {
  if (!payload || payload.component !== 'Transition') {
    return null;
  }

  const transitionRecord = (payload as { transition?: unknown }).transition;
  return transitionRecord && typeof transitionRecord === 'object'
    ? payload
    : null;
};

const hasTransitionPhase = (
  payload: TransitionPayload | null,
  phase: TransitionHookContextShape['phase']
): boolean => {
  return payload ? payload.transition.phases.includes(phase) : true;
};

const readTransitionHook = <THook>(
  payload: TransitionPayload | null,
  payloadHookNames: readonly string[]
): THook | undefined => {
  const payloadHooks = payload?.transition.hooks;

  for (const hookName of payloadHookNames) {
    const candidate =
      payloadHooks?.[hookName as keyof NonNullable<typeof payloadHooks>];
    if (candidate !== undefined) {
      return candidate as THook;
    }
  }

  return undefined;
};

// payload 中可能同时存在别名 hook，这里统一折叠成运行时使用的 hooks/enabled 配置，
// 这样 commit 流程后续就不需要再关心编译产物里到底用了哪一套字段名。
export const resolveOptions = (options: {
  payload: TransitionPayload;
}): ResolvedTransitionOptions => {
  const payload = readRuntimePayload(options.payload);
  if (!payload) {
    throw new Error(
      'Transition runtime execution requires a shared transition payload.'
    );
  }
  const transitionName = payload.transition.name;
  const keySource = payload.transition.key ?? payload.transition.name;

  return {
    payload,
    transitionName,
    stateKey: String(keySource ?? 'default'),
    hooks: {
      appear: readTransitionHook<
        TransitionDispatchHook<TransitionHookContextShape>
      >(payload, ['onAppear', 'appear']),
      enter: readTransitionHook<
        TransitionDispatchHook<TransitionHookContextShape>
      >(payload, ['onEnter', 'enter']),
      leave: readTransitionHook<
        TransitionDispatchHook<TransitionHookContextShape>
      >(payload, ['onLeave', 'leave']),
    },
    enabled: {
      appear: hasTransitionPhase(payload, 'appear'),
      enter: hasTransitionPhase(payload, 'enter'),
      leave: hasTransitionPhase(payload, 'leave'),
    },
  };
};

export const createDebugReport = <TRenderable>(options: {
  stateKey: string;
  visible: boolean;
  runtime: Pick<TransitionRuntime<TRenderable>, 'summarizePrevious'>;
}): TransitionDebugReport => {
  const { stateKey, visible, runtime } = options;
  return {
    stateKey,
    visible,
    ...runtime.summarizePrevious(),
  };
};

export const prepareCommit = <TRenderable>(options: {
  stateKey: string;
  visible: boolean;
  rendered: TRenderable;
  runtime: Pick<TransitionRuntime<TRenderable>, 'summarizePrevious'>;
}): PreparedTransitionCommit<TRenderable> => {
  const { stateKey, visible, rendered, runtime } = options;
  return {
    // commitInput 只保留 commit 真正需要的最小字段，便于后续在 render/commit 两阶段之间传递。
    commitInput: {
      rendered,
      visible,
    },
    debugReport: createDebugReport({
      stateKey,
      visible,
      runtime,
    }),
  };
};

export const prepareRender = <TRenderable>(options: {
  stateKey: string;
  visible: boolean;
  rendered: TRenderable;
  transitionName?: string;
  hooks?: NamedTransitionPhaseHooks;
  enabled?: NamedTransitionPhaseEnabled;
  host?: LeaveFinalizeHost;
  getElements: (snapshot: TRenderable) => readonly Element[];
}): PreparedTransitionRender<TRenderable> => {
  const {
    stateKey,
    visible,
    rendered,
    transitionName,
    hooks,
    enabled,
    host,
    getElements,
  } = options;
  // 每次 render 都基于 stateKey 临时拉起一个 runtime 外观，底层状态仍由 registry 持久化。
  const runtime = bootstrapRuntime<TRenderable>({
    stateKey,
    name: transitionName,
    hooks,
    enabled,
    host,
    getElements,
  });
  const prepared = prepareCommit({
    stateKey,
    visible,
    rendered,
    runtime,
  });

  return {
    runtime,
    prepared,
    debugReport: prepared.debugReport,
  };
};

export const renderTransition = <TRenderable>(options: {
  payload: TransitionPayload;
  visible: boolean;
  rendered: TRenderable;
  host?: LeaveFinalizeHost;
  getElements: (snapshot: TRenderable) => readonly Element[];
}): RenderedTransition<TRenderable> => {
  const { payload, visible, rendered, host, getElements } = options;
  const { stateKey, transitionName, hooks, enabled } = resolveOptions({
    payload,
  });
  const prepared = prepareRender({
    stateKey,
    visible,
    rendered,
    transitionName,
    hooks,
    enabled,
    host,
    getElements,
  });

  return {
    result: prepared.runtime.commit(prepared.prepared.commitInput),
    debugReport: prepared.debugReport,
  };
};

const isPhaseEnabled = (
  enabled: NamedTransitionPhaseEnabled | undefined,
  phase: 'appear' | 'enter' | 'leave'
): boolean => {
  return enabled?.[phase] ?? true;
};

// 首次显示优先触发 appear，再次从隐藏切回可见时触发 enter。
export const dispatchVisiblePhases = <TRenderable>(options: {
  elements: readonly Element[];
  name?: string;
  previous?: TransitionState<TRenderable>;
  hooks?: NamedTransitionPhaseHooks;
  enabled?: NamedTransitionPhaseEnabled;
}): void => {
  const { elements, name, previous, hooks, enabled } = options;

  if (!previous || !previous.appeared) {
    if (!isPhaseEnabled(enabled, 'appear')) {
      return;
    }

    dispatchNamedHooks(hooks?.appear, elements, name, 'appear');
    return;
  }

  if (!previous.visible && isPhaseEnabled(enabled, 'enter')) {
    dispatchNamedHooks(hooks?.enter, elements, name, 'enter');
  }
};

// leaving 阶段先登记离场快照，再把最终清理动作交给 hook settle 回调。
// 这样一来，离场节点会先“被保留并继续可见”，等动画/异步 hook 完成后才真正从 registry 中移除。
export const scheduleLeaving = <TRenderable>(options: {
  stateKey: string;
  previous: TransitionState<TRenderable>;
  name?: string;
  hook?: TransitionDispatchHook<TransitionHookContextShape>;
  host?: LeaveFinalizeHost;
  enabled: boolean;
  getElements: (snapshot: TRenderable) => readonly Element[];
}): TransitionLeavingEntry<TRenderable> | null => {
  const { stateKey, previous, name, hook, host, enabled, getElements } =
    options;
  if (!enabled) {
    return null;
  }

  const leavingEntry = beginTransitionLeaving(stateKey, previous);
  if (!leavingEntry) {
    return null;
  }

  const finalizeLeave = createFinalizeHandler({
    finalize: () => finalizeLeaving(stateKey, leavingEntry.leaveVersion),
    host,
  });
  dispatchNamedHooks(hook, getElements(leavingEntry.snapshot), name, 'leave', {
    defer: false,
    onSettled: finalizeLeave,
  });
  return leavingEntry;
};

// runtime 本身是纯对象实现，所有状态都读写到共享 registry。
export const bootstrapRuntime = <TRenderable>(options: {
  stateKey: string;
  name?: string;
  hooks?: NamedTransitionPhaseHooks;
  enabled?: NamedTransitionPhaseEnabled;
  host?: LeaveFinalizeHost;
  getElements: (snapshot: TRenderable) => readonly Element[];
}): TransitionRuntime<TRenderable> => {
  const { stateKey, name, hooks, enabled, host, getElements } = options;

  return {
    getPrevious() {
      return getTransitionState<TRenderable>(stateKey);
    },
    resolvePrevious() {
      return this.getPrevious();
    },
    summarizePrevious() {
      return createDebugSummary(this.resolvePrevious());
    },
    dispatchVisibleCommitPhases(context) {
      dispatchVisiblePhases({
        elements: context.elements,
        name,
        previous: context.previous,
        hooks,
        enabled,
      });
    },
    publishVisibleCommitState(context) {
      return createBaseCommitResult(
        setTransitionVisibleState(stateKey, context.rendered, context.previous)
      );
    },
    renderVisibleCommitResult(context, _publishResult) {
      return context.rendered;
    },
    commitVisibleContext(context) {
      return applyBaseCommitContext(this, context);
    },
    commitVisible(rendered) {
      const context: TransitionCommitContext<TRenderable> = {
        rendered,
        previous: this.resolvePrevious(),
        elements: getElements(rendered),
      };
      return this.commitVisibleContext(context);
    },
    publishPreviousCommitState(context) {
      const { previous, kind } = context;
      switch (kind) {
        case 'leaving': {
          // 没有可复用快照时直接视为已退出，避免注册一个无法渲染也无法 finalize 的 leaving 记录。
          if (!previous?.visible || !previous.snapshot) {
            setTransitionExitedState(stateKey, previous);
            return {
              kind,
              value: null,
            };
          }

          const leavingEntry = scheduleLeaving({
            stateKey,
            previous,
            name,
            hook: hooks?.leave,
            host,
            enabled: enabled?.leave ?? true,
            getElements,
          });
          if (!leavingEntry) {
            // beginTransitionLeaving 可能因为版本竞争或状态不一致而拒绝登记，此时退回 exited。
            setTransitionExitedState(stateKey, previous);
            return {
              kind,
              value: null,
            };
          }

          return {
            kind,
            value: leavingEntry.snapshot,
          };
        }
        case 'retainedLeaving':
          // 某些 host 会在离场期间继续多次提交；这里只延长 leaving 状态，不重新调度 leave hook。
          if (!previous?.leaving || !previous.snapshot) {
            return {
              kind,
              value: null,
            };
          }

          retainTransitionLeavingState(stateKey, previous);
          return {
            kind,
            value: previous.snapshot,
          };
        case 'hidden':
        default:
          setTransitionExitedState(stateKey, previous);
          return {
            kind,
            value: null,
          };
      }
    },
    renderPreviousCommitResult(_context, publishResult) {
      return publishResult.value;
    },
    commitPreviousContext(context: TransitionPrevCommitContext<TRenderable>) {
      return applyBasePrevContext(this, context);
    },
    commitLeaving() {
      return this.commitPreviousContext({
        previous: this.resolvePrevious(),
        kind: 'leaving',
      });
    },
    commitRetainedLeaving() {
      return this.commitPreviousContext({
        previous: this.resolvePrevious(),
        kind: 'retainedLeaving',
      });
    },
    commitHidden() {
      return this.commitPreviousContext({
        previous: this.resolvePrevious(),
        kind: 'hidden',
      });
    },
    commit({ rendered, visible }: TransitionCommitInput<TRenderable>) {
      const previous = this.resolvePrevious();
      const kind = resolveCommitKind({
        visible,
        previousVisible: previous?.visible ?? false,
        previousLeaving: previous?.leaving ?? false,
        hasSnapshot: Boolean(previous?.snapshot),
      });
      // 这里把所有可见性转换折叠成四种 commit kind，后续每条路径只处理自己的状态机分支。
      switch (kind) {
        case 'visible':
          return this.commitVisible(rendered);
        case 'leaving':
          return this.commitLeaving?.() ?? null;
        case 'retainedLeaving':
          return this.commitRetainedLeaving?.() ?? null;
        case 'hidden':
        default:
          return this.commitHidden?.() ?? null;
      }
    },
  };
};
