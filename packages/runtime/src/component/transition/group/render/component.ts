/**
 * 组织 TransitionGroup 组件层渲染准备流程。
 *
 * 这里负责从共享 payload 提取运行时选项、准备 commit 输入，并返回调试报告。
 * 它本身不直接操作 DOM，而是把“组件输入”整理成 runtime 可以消费的结构化数据。
 *
 * 关注点大致分三段：
 * - 从共享 payload 读取 hostMode、阶段开关与 hook；
 * - 基于本次 renderEntries 结果构造 commit 所需的 key/rendered/previous；
 * - 生成调试摘要，方便外层观测一次 TransitionGroup 提交的差异。
 */
import type { TransitionPayload } from '@lania-v/shared';
import type { TransitionDispatchHook } from '../../host';
import type { GroupHookContext, LeaveFinalizeHost } from '../../registry';
import type {
  PreparedGroupCommit,
  PreparedGroupRender,
  RenderedGroup,
  ResolvedGroupOptions,
  GroupComponentDebugReport,
  GroupPhaseEnabled,
  GroupPhaseHooks,
  TransitionGroupRuntime,
} from '../types';
import { createCommitDebugSummary } from '../state/state';
import {
  createTransitionGroupStateKey,
  resolveTransitionGroupHostMode,
} from '../runtime/host-mode';
import { bootstrapGroupRuntime } from '../runtime/runtime-bootstrap';

// 先渲染条目、再解析 key、最后读取 previous，生成一次 commit 所需的完整输入。
export const prepareGroupCommit = <TRenderable>(options: {
  runtime: Pick<
    TransitionGroupRuntime<TRenderable>,
    'renderEntries' | 'resolveKeys' | 'resolvePrevious'
  >;
  renderEntries: () => readonly TRenderable[];
  explicitKeys?: readonly PropertyKey[];
}): PreparedGroupCommit<TRenderable> => {
  const { runtime, renderEntries, explicitKeys } = options;
  // commit 前先把“本次渲染快照”和“上次状态快照”凑齐，后续 runtime 才能判断 enter/leave/move。
  const rendered = runtime.renderEntries(renderEntries);
  const keys = runtime.resolveKeys(rendered, explicitKeys);
  const previous = runtime.resolvePrevious(keys);
  return {
    rendered,
    keys,
    previous,
    debugSummary: createCommitDebugSummary({
      previous,
      keys,
    }),
    commitInput: {
      keys,
      rendered,
    },
  };
};

export const createGroupDebugReport = <TRenderable>(options: {
  stateKey: string;
  prepared: Pick<PreparedGroupCommit<TRenderable>, 'debugSummary'>;
}): GroupComponentDebugReport => {
  const { stateKey, prepared } = options;
  // 调试报告只复用 commit 摘要，不额外引入新的推导逻辑，避免两套统计口径分叉。
  return {
    stateKey,
    ...prepared.debugSummary,
  };
};

// prepareGroupRender 会同时创建 runtime 与本次渲染的调试摘要。
export const prepareGroupRender = <TRenderable>(options: {
  hostMode: ResolvedGroupOptions['hostMode'];
  stateKey: string;
  transitionTag?: string;
  transitionName?: string;
  leaveHook?: TransitionDispatchHook<GroupHookContext>;
  leaveEnabled: boolean;
  phaseHooks?: GroupPhaseHooks;
  phaseEnabled?: GroupPhaseEnabled;
  host?: LeaveFinalizeHost;
  getElements: (snapshot: TRenderable) => readonly Element[];
  renderEntries: () => readonly TRenderable[];
  explicitKeys?: readonly PropertyKey[];
}): PreparedGroupRender<TRenderable> => {
  const {
    hostMode,
    stateKey,
    transitionTag,
    transitionName,
    leaveHook,
    leaveEnabled,
    phaseHooks,
    phaseEnabled,
    host,
    getElements,
    renderEntries,
    explicitKeys,
  } = options;
  const runtime = bootstrapGroupRuntime({
    hostMode,
    stateKey,
    transitionTag,
    name: transitionName,
    leaveHook,
    leaveEnabled,
    phaseHooks,
    phaseEnabled,
    host,
    getElements,
  });
  const prepared = prepareGroupCommit({
    runtime,
    renderEntries,
    explicitKeys,
  });

  return {
    runtime,
    prepared,
    debugReport: createGroupDebugReport({
      stateKey,
      prepared,
    }),
  };
};

export const renderGroup = <TRenderable>(options: {
  payload: TransitionPayload;
  host?: LeaveFinalizeHost;
  getElements: (snapshot: TRenderable) => readonly Element[];
  renderEntries: () => readonly TRenderable[];
  explicitKeys?: readonly PropertyKey[];
}): RenderedGroup<TRenderable> => {
  const { payload, host, getElements, renderEntries, explicitKeys } = options;
  const {
    hostMode,
    stateKey,
    transitionName,
    transitionTag,
    leaveHook,
    leaveEnabled,
    phaseHooks,
    phaseEnabled,
  } = resolveGroupOptions({
    payload,
  });
  const prepared = prepareGroupRender({
    hostMode,
    stateKey,
    transitionTag,
    transitionName,
    leaveHook,
    leaveEnabled,
    phaseHooks,
    phaseEnabled,
    host,
    getElements,
    renderEntries,
    explicitKeys,
  });

  return {
    // 真正的 DOM/宿主副作用由 runtime.commit 负责；这里仅协调输入与输出结构。
    result: prepared.runtime.commit(prepared.prepared.commitInput),
    debugReport: prepared.debugReport,
  };
};

// 只接受 TransitionGroup 生成的共享 payload，避免普通 transition 混入。
const readGroupPayload = (
  payload: TransitionPayload | undefined
): TransitionPayload | null => {
  if (!payload || payload.component !== 'TransitionGroup') {
    return null;
  }

  const transitionRecord = (payload as { transition?: unknown }).transition;
  return transitionRecord && typeof transitionRecord === 'object'
    ? payload
    : null;
};

const hasTransitionPhase = (
  payload: TransitionPayload | null,
  phase: GroupHookContext['phase']
): boolean => {
  // 未显式提供共享 payload 时默认阶段开启，兼容更宽松的旧调用路径。
  return payload ? payload.transition.phases.includes(phase) : true;
};

const readTransitionHook = <THook>(
  payload: TransitionPayload | null,
  payloadHookNames: readonly string[]
): THook | undefined => {
  const payloadHooks = payload?.transition.hooks;

  for (const hookName of payloadHookNames) {
    // 同一语义兼容 `onEnter` / `enter` 之类双命名，优先返回第一个存在的 hook。
    const candidate =
      payloadHooks?.[hookName as keyof NonNullable<typeof payloadHooks>];
    if (candidate !== undefined) {
      return candidate as THook;
    }
  }

  return undefined;
};

// 根据 payload 解析 host 模式、阶段开关以及具体 hook。
export const resolveGroupOptions = (options: {
  payload: TransitionPayload;
}): ResolvedGroupOptions => {
  const payload = readGroupPayload(options.payload);
  if (!payload) {
    throw new Error(
      'TransitionGroup runtime execution requires a shared transition payload.'
    );
  }
  const transitionName = payload.transition.name;
  const transitionTag = payload.transition.tag;
  const keySource = payload.transition.key ?? payload.transition.name;
  const hostMode = resolveTransitionGroupHostMode(transitionTag);
  const stateKey = createTransitionGroupStateKey(keySource, hostMode);

  return {
    payload,
    hostMode,
    transitionName,
    transitionTag,
    stateKey,
    leaveHook: readTransitionHook<TransitionDispatchHook<GroupHookContext>>(
      payload,
      ['onLeave', 'leave']
    ),
    leaveEnabled: hasTransitionPhase(payload, 'leave'),
    phaseHooks: {
      appear: readTransitionHook<TransitionDispatchHook<GroupHookContext>>(
        payload,
        ['onAppear', 'appear']
      ),
      enter: readTransitionHook<TransitionDispatchHook<GroupHookContext>>(
        payload,
        ['onEnter', 'enter']
      ),
      move: readTransitionHook<TransitionDispatchHook<GroupHookContext>>(
        payload,
        ['onMove', 'move']
      ),
    },
    phaseEnabled: {
      appear: hasTransitionPhase(payload, 'appear'),
      enter: hasTransitionPhase(payload, 'enter'),
      move: hasTransitionPhase(payload, 'move'),
    },
  };
};
