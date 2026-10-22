/**
 * 构建 `TransitionGroup` 的 DOM host 运行时。
 *
 * 当 group 进入 DOM host 模式时，真正参与切换的不再只是“快照数组”，而是一套持续存在的宿主容器：
 * 1. 它维护独立 `container` 以及 active/leave 两个锚点，作为子 block 的统一挂载面；
 * 2. 它分别跟踪当前活跃块、正在离场的块以及离场快照，供后续阶段调度与状态发布复用；
 * 3. 它接收子 block 的注册与移除交接，把“节点离场但尚未清理”的生命周期延续到 group 级 runtime。
 *
 * 这个文件本质上是在把 block 级 DOM host 与 group 级 transition state 串起来。
 */
import {
  registerDomHostRedirect,
  type DomHostBlockRecord,
  type DomHostOwner,
  type DomHostRemovedBlockHandoff,
  type DomHostTarget,
  withDomHost,
} from '../../../host/function-component';
import { createBaseCommitResult } from '../../runtime';
import type { TransitionDispatchHook } from '../../host';
import type { GroupHookContext } from '../../registry';
import { getTransitionGroupState } from '../state/store';
import {
  createDomRenderTarget,
  createDomState,
  createDomStatePublisher,
  createLeavingBlock,
  publishDomBootstrap,
  resolveGroupKeys,
} from '../state/state';
import {
  createPrevCommitResult,
  dispatchDomCommits,
  type DomHostCommitContext,
} from '../render/visible';
import {
  bindDomHostRenderRuntime,
  createDomCommit,
  createDomPhases,
  renderDomPrev,
} from './commit-runtime';
import { registerBlockState, scheduleLeavingBlock } from '../render/phases';
import {
  type GroupDomHostState,
  type GroupDomHostRuntime,
  type GroupCommitInput,
  type GroupLeavingBlock,
  type GroupLeavingSnapshot,
  type GroupPhaseEnabled,
  type GroupPhaseHooks,
} from '../types';
import {
  bindGroupHostRuntime,
  createGroupRuntimeScaffold,
} from './host-scaffold';

// 注释锚点会被注册成 DOM host redirect，方便子块重新找到正确宿主。
export const registerRedirects = <TRenderable>(
  entries: readonly TRenderable[],
  target: DomHostTarget
): void => {
  entries.forEach((entry) => {
    if (entry instanceof Comment) {
      registerDomHostRedirect(entry, target);
      return;
    }

    if (entry instanceof DocumentFragment) {
      [...entry.childNodes].forEach((child) => {
        if (child instanceof Comment) {
          registerDomHostRedirect(child, target);
        }
      });
    }
  });
};

export const resolveRenderedEntries = <TRenderable>(
  entries: readonly TRenderable[]
): TRenderable[] => {
  // 若 render 返回了 fragment，则尽量抽取其中的 Element 作为“真实可见条目”继续参与 group 排序。
  const renderedElementEntries = entries.flatMap((entry) => {
    if (entry instanceof Element) {
      return [entry];
    }
    if (entry instanceof DocumentFragment) {
      return [...entry.childNodes].filter(
        (child): child is Element => child instanceof Element
      );
    }
    return [];
  });

  return renderedElementEntries.length > 0
    ? (renderedElementEntries as TRenderable[])
    : [...entries];
};

export const renderEntries = <TRenderable>(
  target: DomHostTarget,
  renderEntries: () => readonly TRenderable[]
): TRenderable[] => {
  return withDomHost(target, () => {
    // 子 block 在这个作用域里读到的 current dom host，会自然指向 group 容器的 active anchor。
    const rawEntries = [...renderEntries()];
    registerRedirects(rawEntries, target);
    const renderedEntries = resolveRenderedEntries(rawEntries);
    return renderedEntries;
  });
};

export const createEntryRenderer = <TRenderable>(
  runtime: Pick<
    GroupDomHostRuntime<TRenderable>,
    'container' | 'activeAnchor' | 'owner'
  >
): ((renderEntries: () => readonly TRenderable[]) => TRenderable[]) => {
  return (readEntries) =>
    renderEntries(createDomRenderTarget(runtime), readEntries);
};

// DOM host 容器中始终维持 active/leave 两个锚点，便于插入和离场 handoff。
export const ensureAnchors = (
  container: HTMLElement,
  activeAnchor: Comment,
  leaveAnchor: Comment
): void => {
  if (activeAnchor.parentNode !== container) {
    container.appendChild(activeAnchor);
  }
  if (leaveAnchor.parentNode !== container) {
    container.appendChild(leaveAnchor);
  }
  if (
    activeAnchor.compareDocumentPosition(leaveAnchor) &
    Node.DOCUMENT_POSITION_PRECEDING
  ) {
    container.insertBefore(activeAnchor, leaveAnchor);
  }
};

// 复用相同 transition tag 的 previous 容器，避免无谓重建 DOM host 外壳。
export const createDomHostRuntime = <TRenderable>(options: {
  previous?: GroupDomHostState<TRenderable>;
  transitionTag: string;
}): GroupDomHostRuntime<TRenderable> => {
  const { previous, transitionTag } = options;
  const container =
    previous?.container && previous.tag === transitionTag
      ? previous.container
      : document.createElement(transitionTag);
  const activeAnchor =
    previous?.domHostAnchor ??
    document.createComment('lania-transition-group-anchor');
  const leaveAnchor =
    previous?.domHostLeaveAnchor ??
    document.createComment('lania-transition-group-leave-anchor');
  const activeBlocks =
    previous?.activeBlocks ?? new Map<PropertyKey, DomHostBlockRecord>();
  const leavingBlocks =
    previous?.leavingBlocks ?? new Map<PropertyKey, GroupLeavingBlock>();
  const leavingSnapshots =
    previous?.leavingSnapshots ??
    new Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>();
  let leaveVersion = previous?.leaveVersion ?? 0;

  // 复用 previous 时先修正锚点相对位置，避免外部 DOM 变动破坏后续插入语义。
  ensureAnchors(container, activeAnchor, leaveAnchor);
  const runtime = {
    ...createGroupRuntimeScaffold<
      TRenderable,
      DomHostCommitContext<TRenderable>,
      HTMLElement,
      HTMLElement | null
    >({
      resolveKeys(rendered, explicitKeys) {
        return resolveGroupKeys({ rendered, explicitKeys });
      },
    }),
    container,
    activeAnchor,
    leaveAnchor,
    owner: null as unknown as DomHostOwner,
    activeBlocks,
    leavingBlocks,
    leavingSnapshots,
    leaveVersion,
    // 先放入占位实现，后续在 bindDomHostRuntime 中再按 stateKey / hooks 绑定成真实逻辑。
    registerLeavingBlock(_entry: GroupLeavingBlock) {},
    scheduleLeavingBlock(
      _entry: GroupLeavingBlock,
      _handoff: DomHostRemovedBlockHandoff
    ) {},
    dispatchPhases(_options: {
      keys: readonly PropertyKey[];
      previousKeys?: readonly PropertyKey[];
    }) {},
    dispatchVisibleCommitPhases(_context: DomHostCommitContext<TRenderable>) {},
    publishVisibleCommitState(_context: DomHostCommitContext<TRenderable>) {
      return createBaseCommitResult(
        this.getPrevious() ??
          createDomState({
            runtime: this,
          })
      );
    },
    commitLeaving(): TRenderable[] | HTMLElement | null {
      return container;
    },
    commitHidden(): TRenderable[] | HTMLElement | null {
      return container;
    },
    renderVisibleCommitResult(_context: DomHostCommitContext<TRenderable>) {
      return container;
    },
    commitVisible(_options: GroupCommitInput<TRenderable>) {
      return container;
    },
    publishPreviousCommitState(context) {
      return createPrevCommitResult(context.kind, context.previous);
    },
    renderPreviousCommitResult() {
      return renderDomPrev({
        runtime: this,
      });
    },
    createContext({ keys, rendered, previous }) {
      return createDomCommit({
        keys,
        previous,
        runtime: this,
        rendered,
      });
    },
  } satisfies GroupDomHostRuntime<TRenderable>;

  // owner 接收子 block 的注册与移除交接，维护 active/leaving 两份 block 集合。
  const owner: DomHostOwner = {
    registerActiveBlock(block) {
      const key = block.key as PropertyKey;
      activeBlocks.set(key, block);
      const leaving = leavingBlocks.get(key);
      if (!leaving) {
        return;
      }

      // 同 key 的新活跃块出现时，说明旧 leaving 块已经被新内容取代，可以直接完成清理。
      leavingBlocks.delete(key);
      leaving.block.destroyBindings();
      leaving.block.finalizeRemoval();
    },
    handoffRemovedBlock(handoff) {
      const key = handoff.key as PropertyKey;
      if (leavingBlocks.has(key)) {
        // 已经进入 leaving 队列的块不重复 handoff，避免 leaveVersion 与状态仓库出现双份记录。
        return true;
      }

      activeBlocks.delete(key);
      leaveVersion += 1;
      const entry = createLeavingBlock(
        key,
        handoff.block,
        handoff.previousIndex,
        leaveVersion
      );
      leavingBlocks.set(key, entry);
      runtime.leaveVersion = leaveVersion;
      runtime.registerLeavingBlock(entry);
      ensureAnchors(container, activeAnchor, leaveAnchor);
      // 先把块移动到 leave anchor 前，再把异步 leave 调度交给 runtime。
      handoff.block.moveBefore(leaveAnchor);
      runtime.scheduleLeavingBlock(entry, handoff);
      return true;
    },
  };
  runtime.owner = owner;

  return runtime;
};

// 把状态发布、阶段调度与 DOM host 渲染入口全部绑定到 runtime。
// `createDomHostRuntime` 只负责搭骨架；真正依赖 stateKey、hooks 的行为都在这里补齐。
export const bindDomHostRuntime = <TRenderable>(options: {
  stateKey: string;
  transitionTag: string;
  runtime: GroupDomHostRuntime<TRenderable>;
  keys: readonly PropertyKey[];
  snapshots: readonly TRenderable[];
  name?: string;
  hook?: TransitionDispatchHook<GroupHookContext>;
  phaseHooks?: GroupPhaseHooks;
  phaseEnabled?: GroupPhaseEnabled;
}): GroupDomHostRuntime<TRenderable> => {
  const {
    stateKey,
    transitionTag,
    runtime,
    keys,
    snapshots,
    name,
    hook,
    phaseHooks,
    phaseEnabled,
  } = options;
  const publishDomHostState = createDomStatePublisher({
    stateKey,
    runtime,
    transitionTag,
  });
  const dispatchDomHostPhases = createDomPhases({
    stateKey,
    container: runtime.container,
    name,
    hooks: phaseHooks,
    enabled: phaseEnabled,
  });

  runtime.registerLeavingBlock = (entry) => {
    runtime.leaveVersion = entry.leaveVersion;
    registerBlockState(stateKey, entry);
  };
  runtime.scheduleLeavingBlock = (entry, handoff) => {
    // leaving 调度只登记异步离场流程，真实节点位置已在 handoff 时被移动到 leave anchor 前。
    scheduleLeavingBlock({
      stateKey,
      entry,
      previousIndex: handoff.previousIndex,
      name,
      hook,
    });
  };
  runtime.dispatchPhases = ({ keys: phaseKeys, previousKeys }) => {
    dispatchDomHostPhases({
      keys: phaseKeys,
      previousKeys,
    });
  };
  runtime.renderEntries = createEntryRenderer(runtime);
  bindGroupHostRuntime({
    stateKey,
    runtime,
    publishState: publishDomHostState,
    dispatchVisibleCommitPhases: (context) => {
      dispatchDomCommits({
        runtime,
        context,
      });
    },
  });
  bindDomHostRenderRuntime({
    stateKey,
    runtime,
  });
  publishDomBootstrap({
    stateKey,
    runtime,
    transitionTag,
    keys,
    snapshots,
  });

  return runtime;
};

export const bootstrapDomHostRuntime = <TRenderable>(options: {
  stateKey: string;
  transitionTag: string;
  keys?: readonly PropertyKey[];
  snapshots?: readonly TRenderable[];
  name?: string;
  hook?: TransitionDispatchHook<GroupHookContext>;
  phaseHooks?: GroupPhaseHooks;
  phaseEnabled?: GroupPhaseEnabled;
}): GroupDomHostRuntime<TRenderable> => {
  const { stateKey, transitionTag, name, hook, phaseHooks, phaseEnabled } =
    options;
  const previous = getTransitionGroupState<TRenderable>(stateKey);
  const keys = options.keys ?? previous?.keys ?? [];
  const snapshots = options.snapshots ?? previous?.snapshots ?? [];
  return bindDomHostRuntime({
    stateKey,
    transitionTag,
    keys,
    snapshots,
    runtime: createDomHostRuntime({
      previous,
      transitionTag,
    }),
    name,
    hook,
    phaseHooks,
    phaseEnabled,
  });
};
