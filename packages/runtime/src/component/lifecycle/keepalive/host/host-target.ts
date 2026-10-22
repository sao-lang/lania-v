/**
 * 负责 `KeepAlive` 宿主目标的解析、修复与挂载状态维护。
 *
 * 这里聚合了 keepalive 节点“挂到哪里去”的基础设施，覆盖三类能力：
 * 1. 维护节点快照、hydration 节点与最近一次成功解析出的宿主目标；
 * 2. 在 redirect target、上下文 target、节点反推 target 之间选择当前最可靠的挂载位置；
 * 3. 为 queued surface 提供排队提交、批量 flush 和目标缓存复用能力。
 *
 * 可以把它理解成 keepalive 的“宿主层适配中枢”，上层实例与 bucket 逻辑都通过这里与真实 DOM 对接。
 */
import {
  type KeepAliveHostAdapter,
  type KeepAliveHostCommitter,
  type KeepAliveHostTarget,
  type KeepAliveTargetOptions,
  type KeepAliveTargetResolver,
  type KeepAliveMountedHostState,
  type KeepAliveHostState,
  type KeepAliveQueuedSurface,
} from '../types';
import {
  getCurrentDomHostTarget,
  getDomHostRedirect,
  type DomHostOwner,
} from '../../../host/function-component';
import {
  createMountedSurfaceDef,
  createQueuedSurface,
  createRetainedSurface,
} from '../mounted-surface';
import { createAdapterCommitter } from './host-controller';

// queued surface 先缓存待提交节点，等 mounted.update 时再一次性冲刷到宿主。
export const createQueuedMountedSurface = (options: {
  initialNodes: readonly Node[];
  adapter: KeepAliveHostAdapter;
  resolvePreferredTarget(): KeepAliveHostTarget | null;
  inferTarget?(nodes: readonly Node[]): KeepAliveHostTarget | null;
  detach?(nodes: readonly Node[]): void;
  destroy?(): void;
}): KeepAliveQueuedSurface => {
  const {
    initialNodes,
    adapter,
    resolvePreferredTarget,
    inferTarget,
    detach,
    destroy,
  } = options;
  const hostState = createMountedHostState(initialNodes);
  const resolver = createCachedTargetResolver({
    readNodes() {
      return hostState.readNodes();
    },
    readCachedTarget() {
      return hostState.readCachedTarget();
    },
    writeCachedTarget(target) {
      hostState.writeCachedTarget(target);
    },
    isMounted() {
      return hostState.isMounted();
    },
    resolvePreferredTarget,
    inferTarget,
  });
  const host = createAdapterCommitter({
    readCurrentNodes() {
      return hostState.readNodes();
    },
    resolver,
    adapter,
    syncNodes(nextNodes) {
      hostState.syncNodes(nextNodes);
    },
  });
  const queuedNodes = createQueuedState<readonly Node[]>({
    commit(nextNodes) {
      host.commit(nextNodes);
    },
  });
  const mounted = createRetainedSurface(
    createMountedSurfaceDef({
      hostState,
      update() {
        queuedNodes.flush();
      },
      activate() {},
      detach,
      destroy,
    })
  );

  return createQueuedSurface({
    mounted,
    queueNodes(nextNodes) {
      queuedNodes.queue(nextNodes);
    },
    clearQueuedNodes() {
      queuedNodes.clear();
    },
    afterDestroy() {
      hostState.clearCachedTarget();
    },
  });
};

// node host state 管理一组可回收节点及其最近一次解析出的挂载目标。
export const createNodeHostState = (options: {
  acquireNodes(): Node[];
  releaseNodes(nodes: Node[]): void;
}): KeepAliveHostState => {
  const { acquireNodes, releaseNodes } = options;
  let currentNodes: Node[] | null = acquireNodes();
  let hydratedNodes: Node[] | null = null;
  let cachedHostTarget: KeepAliveHostTarget | null = null;

  const ensureNodes = (): Node[] => {
    currentNodes ??= acquireNodes();
    return currentNodes;
  };

  // sync 不替换数组引用，而是原地改写缓存数组，方便外部长期持有同一份节点容器。
  const syncNodes = (nodes: readonly Node[]): void => {
    const target = ensureNodes();
    target.length = 0;
    target.push(...nodes);
  };

  return {
    readNodes() {
      return currentNodes ?? [];
    },
    ensureNodes,
    syncNodes,
    hydrate(nodes) {
      syncNodes(nodes);
      hydratedNodes = [...nodes];
    },
    readHydratedNodes() {
      return hydratedNodes;
    },
    clearHydrated() {
      hydratedNodes = null;
    },
    readCachedTarget() {
      return cachedHostTarget;
    },
    writeCachedTarget(target) {
      cachedHostTarget = target;
    },
    isMounted() {
      if (!cachedHostTarget) {
        return false;
      }
      if (
        cachedHostTarget.anchor &&
        cachedHostTarget.anchor.parentNode !== cachedHostTarget.parent
      ) {
        return false;
      }
      return (currentNodes ?? []).some((node) => node.parentNode !== null);
    },
    destroy() {
      if (currentNodes) {
        releaseNodes(currentNodes);
        currentNodes = null;
      }
      hydratedNodes = null;
      cachedHostTarget = null;
    },
  };
};

// mounted host state 面向已挂载表面，只跟踪当前节点快照和 mount 标记。
export const createMountedHostState = (
  initialNodes: readonly Node[]
): KeepAliveMountedHostState => {
  let currentNodes = [...initialNodes];
  let cachedHostTarget: KeepAliveHostTarget | null = null;
  let mounted = false;

  return {
    readNodes() {
      return currentNodes;
    },
    syncNodes(nodes) {
      currentNodes = [...nodes];
      mounted = nodes.some((node) => node.parentNode !== null);
      if (!mounted) {
        cachedHostTarget = null;
      }
    },
    readCachedTarget() {
      return cachedHostTarget;
    },
    writeCachedTarget(target) {
      cachedHostTarget = target;
    },
    clearCachedTarget() {
      cachedHostTarget = null;
    },
    isMounted() {
      return mounted;
    },
    markUnmounted() {
      mounted = false;
    },
  };
};

export const createHostCommitter = (options: {
  readCurrentNodes(): readonly Node[];
  resolveTarget(): KeepAliveHostTarget | null;
  mountNodes(target: KeepAliveHostTarget, nodes: readonly Node[]): void;
  unmountNodes(nodes: readonly Node[]): void;
  syncNodes(nodes: readonly Node[]): void;
}): KeepAliveHostCommitter => {
  const {
    readCurrentNodes,
    resolveTarget,
    mountNodes,
    unmountNodes,
    syncNodes,
  } = options;

  return {
    commit(nodes) {
      const target = resolveTarget();
      // 先卸载旧节点，再把新快照整体挂回目标，保证 host 侧看到的是一次完整替换。
      unmountNodes(readCurrentNodes());
      if (target) {
        mountNodes(target, nodes);
      }
      syncNodes(nodes);
    },
    sync(nodes) {
      syncNodes(nodes);
    },
    clear() {
      unmountNodes(readCurrentNodes());
      syncNodes([]);
    },
  };
};

export const createTargetResolver = (
  resolve: () => KeepAliveHostTarget | null
): KeepAliveTargetResolver => {
  return {
    resolve,
  };
};

export const readRedirectTarget = (
  anchor: Node
): KeepAliveHostTarget | null => {
  const redirect = getDomHostRedirect(anchor);
  return redirect ? { parent: redirect.parent, anchor: redirect.anchor } : null;
};

export const readContextualTarget = (): KeepAliveHostTarget | null => {
  const domHost = getCurrentDomHostTarget() as
    { parent: Node; anchor: Node; owner?: DomHostOwner } | undefined;
  return domHost
    ? { parent: domHost.parent, anchor: domHost.anchor, owner: domHost.owner }
    : null;
};

export const resolveAnchorFallback = (
  anchor: Node
): KeepAliveHostTarget | null => {
  const parent = anchor.parentNode;
  return parent ? { parent, anchor } : null;
};

export const resolveContextualPreferred = (): KeepAliveHostTarget | null => {
  return readContextualTarget();
};

export const resolveAnchorPreferred = (
  anchor: Node
): KeepAliveHostTarget | null => {
  return resolvePreferredTarget({
    fallbackTarget: resolveAnchorFallback(anchor),
    redirectedTarget: readRedirectTarget(anchor),
    contextualTarget: readContextualTarget(),
  });
};

export const resolveAnchorDomTarget = (options: {
  parent: Node;
  anchor: Node;
}): KeepAliveHostTarget => {
  const { parent, anchor } = options;
  const fallbackTarget: KeepAliveHostTarget = { parent, anchor };
  const contextualTarget = readContextualTarget();
  const resolved = resolvePreferredTarget({
    fallbackTarget,
    redirectedTarget: readRedirectTarget(anchor),
    contextualTarget,
  });

  if (!resolved) {
    return fallbackTarget;
  }

  if (
    contextualTarget &&
    resolved.parent === contextualTarget.parent &&
    resolved.anchor === contextualTarget.anchor
  ) {
    return contextualTarget;
  }

  return resolved;
};

// 优先复用仍然有效的缓存目标，否则依次尝试 preferred target 与节点反推。
// 这样既能减少频繁解析目标的开销，也能在节点暂时脱离 DOM 时尽量记住上一次可用位置。
export const createCachedTargetResolver = (options: {
  readNodes(): readonly Node[];
  readCachedTarget(): KeepAliveHostTarget | null;
  writeCachedTarget(target: KeepAliveHostTarget | null): void;
  isMounted(): boolean;
  resolvePreferredTarget(): KeepAliveHostTarget | null;
  inferTarget?(nodes: readonly Node[]): KeepAliveHostTarget | null;
}): KeepAliveTargetResolver => {
  const {
    readNodes,
    readCachedTarget,
    writeCachedTarget,
    isMounted,
    resolvePreferredTarget,
    inferTarget,
  } = options;

  return createTargetResolver(() => {
    const cachedTarget = readCachedTarget();
    // 已挂载时优先复用缓存目标，避免一次 commit 里重复回溯上下文与节点位置。
    // 这里隐含的前提是：mounted 节点仍代表当前 entry 的真实宿主位置。
    if (cachedTarget && isMounted()) {
      return cachedTarget;
    }

    const preferredTarget = resolvePreferredTarget();
    if (preferredTarget) {
      // 一旦拿到显式可用目标，就立刻刷新缓存，供后续节点短暂脱 DOM 时继续兜底。
      writeCachedTarget(preferredTarget);
      return preferredTarget;
    }

    const inferredTarget = inferTarget?.(readNodes()) ?? null;
    writeCachedTarget(inferredTarget);
    return inferredTarget;
  });
};

export const createAnchorResolver = (options: {
  anchor: Node;
  readNodes(): readonly Node[];
  readCachedTarget(): KeepAliveHostTarget | null;
  writeCachedTarget(target: KeepAliveHostTarget | null): void;
  isMounted(): boolean;
  inferTarget?(nodes: readonly Node[]): KeepAliveHostTarget | null;
}): KeepAliveTargetResolver => {
  const {
    anchor,
    readNodes,
    readCachedTarget,
    writeCachedTarget,
    isMounted,
    inferTarget,
  } = options;

  return createCachedTargetResolver({
    readNodes,
    readCachedTarget,
    writeCachedTarget,
    isMounted,
    resolvePreferredTarget() {
      return resolveAnchorPreferred(anchor);
    },
    inferTarget,
  });
};

// 轻量排队器用于把多次写入压缩到下一次显式 flush。
export const createQueuedState = <TValue>(options: {
  commit(value: TValue): void;
}) => {
  const { commit } = options;
  let hasPending = false;
  let pendingValue: TValue | null = null;

  return {
    hasPending() {
      return hasPending;
    },
    queue(value: TValue) {
      pendingValue = value;
      hasPending = true;
    },
    flush() {
      if (!hasPending) {
        return false;
      }
      const value = pendingValue as TValue;
      pendingValue = null;
      hasPending = false;
      commit(value);
      return true;
    },
    clear() {
      pendingValue = null;
      hasPending = false;
    },
  };
};

// 当 anchor 被外部移动后，尽量把它修回原父节点，否则退回备用目标。
// 这里不抛错，而是选择保守降级，避免 keepalive 在宿主被外部改动时直接中断整条提交流程。
export const repairHostTarget = (
  target: KeepAliveHostTarget,
  fallbackTarget: KeepAliveHostTarget
): KeepAliveHostTarget => {
  if (target.anchor === null) {
    return target;
  }

  if (target.anchor.parentNode === target.parent) {
    return target;
  }

  try {
    target.parent.appendChild(target.anchor);
    return target;
  } catch {
    return fallbackTarget;
  }
};

export const resolveHostTarget = (
  options: KeepAliveTargetOptions
): KeepAliveHostTarget => {
  const { fallbackTarget, redirectedTarget, contextualTarget } = options;

  if (redirectedTarget) {
    // redirect 优先级最高，因为它通常显式表达了“子树应该被重新交给哪个宿主管理”。
    // 这类目标一般来自更高层编排决策，因此应覆盖当前上下文自动推断出的宿主。
    return repairHostTarget(redirectedTarget, fallbackTarget);
  }

  if (contextualTarget) {
    // 没有 redirect 时再退回当前运行时上下文暴露的宿主位置。
    // contextual target 代表“当前 commit 环境认为的最佳位置”，优先于静态 fallback。
    return repairHostTarget(contextualTarget, fallbackTarget);
  }

  return fallbackTarget;
};

export const resolvePreferredTarget = (options: {
  fallbackTarget: KeepAliveHostTarget | null;
  redirectedTarget?: KeepAliveHostTarget | null;
  contextualTarget?: KeepAliveHostTarget | null;
}): KeepAliveHostTarget | null => {
  const {
    fallbackTarget,
    redirectedTarget = null,
    contextualTarget = null,
  } = options;

  if (!fallbackTarget) {
    return null;
  }

  return resolveHostTarget({
    fallbackTarget,
    redirectedTarget,
    contextualTarget,
  });
};
