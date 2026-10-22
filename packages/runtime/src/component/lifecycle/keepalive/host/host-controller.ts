/**
 * 组合 KeepAlive 宿主提交器与未缓存实例控制器。
 *
 * 这里把 anchor/contextual 目标解析、DOM 适配器和 uncached 替换流程包装成
 * 更高层的运行时工厂，供 keepalive registry 与 slot/runtime 共用。
 *
 * 文件内部可以分成三块职责：
 * 1. `createAdapterCommitter` 把 resolver/adapter/syncNodes 折叠成统一的 host commit 接口；
 * 2. `createAnchoredHost` / `createContextualNodeHost` 根据宿主目标来源不同，构造两种 node host；
 * 3. `clear/replace/createUncachedController` 为“不进缓存”的实例维持最小替换协议。
 *
 * 这样上层 keepalive runtime 只需要关心“要把哪些节点提交到哪里”，不必再重复拼装
 * 目标解析、节点快照同步和 uncached 实例销毁时序。
 */
import {
  type KeepAliveHostRuntime,
  type KeepAliveNodeRuntime,
  type KeepAliveHostAdapter,
  type KeepAliveHostCommitter,
  type KeepAliveHostTarget,
  type KeepAliveTargetResolver,
  type KeepAliveHostState,
  type KeepAliveUncached,
  type KeepAliveUncachedState,
  keepAliveDomHostAdapter,
  createTargetReader,
} from '../types';
import { createUncachedState } from '../runtime/runtime-state';
import {
  createAnchorResolver,
  createCachedTargetResolver,
  createHostCommitter,
  createNodeHostState,
  resolveContextualPreferred,
} from './host-target';

// 适配器提交器把目标解析与节点同步桥接到统一的 host.commit 接口。
export const createAdapterCommitter = (options: {
  readCurrentNodes(): readonly Node[];
  resolver: KeepAliveTargetResolver;
  adapter: KeepAliveHostAdapter;
  syncNodes(nodes: readonly Node[]): void;
}): KeepAliveHostCommitter => {
  const { readCurrentNodes, resolver, adapter, syncNodes } = options;
  return createHostCommitter({
    readCurrentNodes,
    resolveTarget() {
      return resolver.resolve();
    },
    mountNodes(target, nodes) {
      adapter.mount(target, nodes);
    },
    unmountNodes(nodes) {
      adapter.unmount(nodes);
    },
    syncNodes,
  });
};

// anchored host 固定围绕某个 anchor 决定挂载点，适合模板内局部缓存。
export const createAnchoredHost = (options: {
  anchor: Node;
  hostState: Pick<
    KeepAliveHostState,
    | 'readNodes'
    | 'readCachedTarget'
    | 'writeCachedTarget'
    | 'isMounted'
    | 'syncNodes'
  >;
  adapter?: KeepAliveHostAdapter;
  inferTarget?(nodes: readonly Node[]): KeepAliveHostTarget | null;
}): KeepAliveHostRuntime => {
  const {
    anchor,
    hostState,
    adapter = keepAliveDomHostAdapter,
    inferTarget,
  } = options;
  const resolver = createAnchorResolver({
    anchor,
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
    inferTarget,
  });

  return {
    resolver,
    host: createAdapterCommitter({
      readCurrentNodes() {
        return hostState.readNodes();
      },
      resolver,
      adapter,
      syncNodes(nodes) {
        hostState.syncNodes(nodes);
      },
    }),
    readHostTarget: createTargetReader(resolver),
  };
};

export const createAnchoredNodeHost = (options: {
  anchor: Node;
  acquireNodes(): Node[];
  releaseNodes(nodes: Node[]): void;
  adapter?: KeepAliveHostAdapter;
  inferTarget?(nodes: readonly Node[]): KeepAliveHostTarget | null;
}): KeepAliveNodeRuntime => {
  const { anchor, acquireNodes, releaseNodes, adapter, inferTarget } = options;
  // node host state 负责把“外部节点所有权”抽象成可读写状态，便于 anchored/contextual 复用。
  const hostState = createNodeHostState({
    acquireNodes,
    releaseNodes,
  });
  return {
    hostState,
    ...createAnchoredHost({
      anchor,
      hostState,
      adapter,
      inferTarget,
    }),
  };
};

// contextual host 优先复用当前上下文暴露的 DOM host，再退回推断目标。
export const createContextualNodeHost = (options: {
  acquireNodes(): Node[];
  releaseNodes(nodes: Node[]): void;
  adapter?: KeepAliveHostAdapter;
  inferTarget?(nodes: readonly Node[]): KeepAliveHostTarget | null;
  resolvePreferredTarget?(): KeepAliveHostTarget | null;
}): KeepAliveNodeRuntime => {
  const {
    acquireNodes,
    releaseNodes,
    adapter = keepAliveDomHostAdapter,
    inferTarget,
    resolvePreferredTarget = resolveContextualPreferred,
  } = options;
  const hostState = createNodeHostState({
    acquireNodes,
    releaseNodes,
  });
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

  return {
    hostState,
    resolver,
    host: createAdapterCommitter({
      readCurrentNodes() {
        return hostState.readNodes();
      },
      resolver,
      adapter,
      syncNodes(nodes) {
        hostState.syncNodes(nodes);
      },
    }),
    readHostTarget: createTargetReader(resolver),
  };
};

// uncached 分支只保留单个活动实例，因此替换前要先显式销毁旧值。
export const clearUncachedInstance = <TInstance>(options: {
  state: KeepAliveUncachedState<TInstance>;
  destroy(instance: TInstance): void;
}): boolean => {
  const { state, destroy } = options;
  const current = state.current;
  if (!current) {
    return false;
  }

  destroy(current);
  state.current = null;
  return true;
};

export const replaceUncachedInstance = <TInstance>(options: {
  state: KeepAliveUncachedState<TInstance>;
  nextInstance: TInstance;
  destroy(instance: TInstance): void;
  readNodes(instance: TInstance): readonly Node[];
  mountNodes(nodes: readonly Node[]): void;
  syncNodes(nodes: readonly Node[]): void;
}): readonly Node[] => {
  const { state, nextInstance, destroy, readNodes, mountNodes, syncNodes } =
    options;

  clearUncachedInstance({
    state,
    destroy,
  });

  const nodes = readNodes(nextInstance);
  mountNodes(nodes);
  syncNodes(nodes);
  state.current = nextInstance;
  return nodes;
};

// 对外暴露的 uncached controller 维持 `replace/clear/readCurrent` 三个最小操作。
export const createUncachedController = <TInstance>(options: {
  state?: KeepAliveUncachedState<TInstance>;
  destroy(instance: TInstance): void;
  readNodes(instance: TInstance): readonly Node[];
  host: KeepAliveHostCommitter;
}): KeepAliveUncached<TInstance> => {
  const {
    destroy,
    readNodes,
    host,
    state = createUncachedState<TInstance>(),
  } = options;

  return {
    replace(nextInstance) {
      // uncached 路径始终按“整实例替换”处理，不尝试做旧实例与新实例之间的细粒度协调。
      return replaceUncachedInstance({
        state,
        nextInstance,
        destroy,
        readNodes,
        mountNodes(nodes) {
          host.commit(nodes);
        },
        // uncached controller 的宿主同步已经由 `host.commit()` 覆盖，这里不再额外维护节点映射。
        syncNodes() {},
      });
    },
    clear() {
      const didClear = clearUncachedInstance({
        state,
        destroy,
      });
      if (didClear) {
        host.clear();
      }
      return didClear;
    },
    readCurrent() {
      return state.current;
    },
  };
};
