/**
 * 组织 `KeepAlive` 挂载表面与实例工厂。
 *
 * 这个模块的重点不是缓存策略，而是把“实例如何托管一组节点”这件事拆成可复用部件：
 * 1. retained surface 负责记住最近一次仍可复用的节点与宿主位置；
 * 2. queued surface 在 retained surface 之上补上延迟提交与销毁清理语义；
 * 3. source / node / contextual 三类工厂把不同来源的数据统一封装成 keepalive instance。
 *
 * 上层 bucket、slot 与 registry 不需要关心这些挂载细节，只消费这里产出的统一实例协议。
 */
import {
  keepAliveDomHostAdapter,
  type KeepAliveHostTarget,
  type KeepAliveInstance,
  type KeepAliveInstanceEntry,
  type KeepAliveSourceDef,
  resolveMountedTarget,
  type KeepAliveSourceFactory,
  type KeepAliveSurface,
  type KeepAliveQueuedInstance,
  type KeepAliveNodeDef,
  type KeepAliveNodeFactory,
  type KeepAliveQueuedSurface,
  type KeepAliveMountedHostState,
  type KeepAliveRetainedSurfaceDef,
  type KeepAliveRetainedSource,
} from './types';
import {
  createMountedFactory,
  createMountedInstance,
  createQueueableInstance,
} from './instance-adapters';
import {
  createQueuedMountedSurface,
  resolveContextualPreferred,
} from './host/host';

// retained surface 会尽量记住最近一次仍然挂在 DOM 中的节点快照。
export const createRetainedSurface = (
  options: KeepAliveRetainedSurfaceDef
): KeepAliveSurface => {
  const {
    initialNodes = [],
    readLiveNodes,
    readHostTarget,
    update,
    activate,
    detach,
    destroy,
  } = options;
  let retainedNodes = [...initialNodes];
  const syncRetainedNodes = (): readonly Node[] => {
    const nextNodes = readLiveNodes();
    // 只有读到真实活跃节点时才刷新 retained 快照，避免 detach 后把缓存误刷成空数组。
    if (nextNodes.length > 0) {
      retainedNodes = [...nextNodes];
    }
    return nextNodes;
  };

  return {
    readNodes() {
      const nextNodes = readLiveNodes();
      const liveNodes = nextNodes.filter((node) => node.parentNode !== null);
      if (liveNodes.length > 0) {
        retainedNodes = [...liveNodes];
        return liveNodes;
      }
      return retainedNodes.length > 0 ? retainedNodes : nextNodes;
    },
    readHostTarget() {
      return readHostTarget();
    },
    isMounted() {
      return readLiveNodes().some((node) => node.parentNode !== null);
    },
    update() {
      update?.();
      syncRetainedNodes();
    },
    activate() {
      activate?.();
      syncRetainedNodes();
    },
    detach() {
      const previousNodes = readLiveNodes();
      retainedNodes = [...previousNodes];
      detach?.(previousNodes);
    },
    destroy() {
      retainedNodes = [];
      destroy?.();
    },
  };
};

// 把 mounted host state 翻译成 retained surface 所需的读写接口。
export const createMountedSurfaceDef = (options: {
  hostState: KeepAliveMountedHostState;
  update?(): void;
  activate?(): void;
  detach?(nodes: readonly Node[]): void;
  destroy?(): void;
}): KeepAliveRetainedSurfaceDef => {
  const { hostState, update, activate, detach, destroy } = options;
  return {
    initialNodes: hostState.readNodes(),
    readLiveNodes() {
      return hostState.readNodes();
    },
    readHostTarget() {
      return hostState.readCachedTarget();
    },
    update,
    activate,
    detach(previousNodes) {
      detach?.(previousNodes);
      hostState.markUnmounted();
    },
    destroy() {
      destroy?.();
      hostState.clearCachedTarget();
    },
  };
};

// queued surface 在基础 surface 上附加排队节点和销毁清理语义。
export const createQueuedSurface = (options: {
  mounted: KeepAliveSurface;
  queueNodes(nodes: readonly Node[]): void;
  clearQueuedNodes?(): void;
  afterDestroy?(): void;
}): KeepAliveQueuedSurface => {
  const { mounted, queueNodes, clearQueuedNodes, afterDestroy } = options;
  return {
    ...mounted,
    queueNodes,
    commitQueuedNodes() {
      mounted.update();
    },
    destroy() {
      clearQueuedNodes?.();
      mounted.detach();
      mounted.destroy();
      afterDestroy?.();
    },
  };
};

export const createRetainedInstance = <TValue>(options: {
  readValue(): TValue;
  initialNodes?: readonly Node[];
  readLiveNodes(): readonly Node[];
  readHostTarget(): KeepAliveHostTarget | null;
  update?(): void;
  activate?(): void;
  detach?(nodes: readonly Node[]): void;
  destroy?(): void;
  initiallyActive?: boolean;
}): {
  mounted: KeepAliveSurface;
  instance: KeepAliveInstance<TValue>;
} => {
  const {
    readValue,
    initialNodes,
    readLiveNodes,
    readHostTarget,
    update,
    activate,
    detach,
    destroy,
    initiallyActive,
  } = options;
  const mounted = createRetainedSurface({
    initialNodes,
    readLiveNodes,
    readHostTarget,
    update,
    activate,
    detach,
    destroy,
  });

  // 这里把“节点托管表面”和“对外暴露的 keepalive instance”一次性成对产出，方便上层同时接入。
  return createMountedFactory<
    TValue,
    KeepAliveSurface,
    KeepAliveInstance<TValue>
  >({
    createRecordOptions() {
      return {
        readValue,
        mounted,
        initiallyActive,
      };
    },
    createInstance(instanceOptions) {
      return createMountedInstance(instanceOptions);
    },
  }).createRecord();
};

export const createRetainedSourceInstance = <TValue>(
  options: KeepAliveRetainedSource<TValue>
): KeepAliveInstance<TValue> => {
  const { instance } = createRetainedInstance(options);
  return instance;
};

export const resolveRetainedSource = <TSource, TValue>(
  options: KeepAliveSourceDef<TSource, TValue>
): KeepAliveRetainedSource<TValue> => {
  const {
    source,
    readValue,
    readLiveNodes,
    readHostTarget,
    update,
    activate,
    deactivate,
    destroy,
    initiallyActive,
  } = options;

  return {
    readValue() {
      return readValue(source);
    },
    // 初始节点快照只在创建 retained surface 时读取一次，后续实时节点通过 readLiveNodes 读取。
    initialNodes: readLiveNodes(source),
    readLiveNodes() {
      return readLiveNodes(source);
    },
    readHostTarget,
    update() {
      update?.(source);
    },
    activate() {
      activate?.(source);
    },
    deactivate(previousNodes) {
      deactivate?.(source, previousNodes);
    },
    destroy() {
      destroy?.(source);
    },
    initiallyActive,
  };
};

export const createSourceInstance = <TSource, TValue>(
  options: KeepAliveSourceDef<TSource, TValue>
): KeepAliveInstance<TValue> => {
  return createLiveSourceFactory({
    createDefinition() {
      return options;
    },
  }).createInstance();
};

// source factory 每次创建实例时都会重新解析 source 定义，避免跨实例共享可变状态。
// 这样如果 source 内部捕获了局部上下文，每个缓存实例拿到的都是独立定义副本。
export const createLiveSourceFactory = <TSource, TValue>(options: {
  createDefinition(): KeepAliveSourceDef<TSource, TValue>;
}): KeepAliveSourceFactory<TValue> => {
  const { createDefinition } = options;
  return createMountedFactory<
    TValue,
    KeepAliveSurface,
    KeepAliveInstance<TValue>
  >({
    createRecordOptions() {
      const retainedOptions = resolveRetainedSource(createDefinition());
      return {
        readValue: retainedOptions.readValue,
        mounted: createRetainedSurface(retainedOptions),
        initiallyActive: retainedOptions.initiallyActive,
      };
    },
    createInstance(instanceOptions) {
      return createMountedInstance(instanceOptions);
    },
  });
};

export const createInstanceEntry = <
  TInstance extends KeepAliveInstance<unknown>,
>(
  key: string,
  instance: TInstance
): KeepAliveInstanceEntry<TInstance> => {
  return { key, instance };
};

export const createSourceEntry = <TSource, TValue>(
  options: {
    key: string;
  } & KeepAliveSourceDef<TSource, TValue>
): KeepAliveInstanceEntry<KeepAliveInstance<TValue>> => {
  const { key, ...instanceOptions } = options;
  return createLiveSourceFactory({
    createDefinition() {
      return instanceOptions;
    },
  }).createEntry(key);
};

export const createNodeBackedInstance = <TValue>(
  options: KeepAliveNodeDef<TValue>
): KeepAliveQueuedInstance<TValue> => {
  return createNodeFactory({
    createDefinition() {
      return options;
    },
  }).createInstance();
};

// node factory 面向现成节点数组，主要服务于 slot/hydration 这类已有 DOM 的场景。
// 它不会重新“生产节点”，而是围绕现成 DOM 建一个可排队、可重新挂载的 keepalive 实例。
export const createNodeFactory = <TValue>(options: {
  createDefinition(): KeepAliveNodeDef<TValue>;
}): KeepAliveNodeFactory<TValue> => {
  const { createDefinition } = options;
  return createMountedFactory<
    TValue,
    KeepAliveQueuedSurface,
    KeepAliveQueuedInstance<TValue>
  >({
    createRecordOptions() {
      const definition = createDefinition();
      const mounted = createQueuedMountedSurface({
        initialNodes: definition.initialNodes,
        adapter: definition.adapter,
        resolvePreferredTarget: definition.resolvePreferredTarget,
        inferTarget: definition.inferTarget,
        detach: definition.detach,
        destroy: definition.destroy,
      });
      return {
        readValue() {
          return definition.readValue(mounted.readNodes());
        },
        mounted,
        initiallyActive: definition.initiallyActive ?? true,
      };
    },
    createInstance(instanceOptions) {
      return createQueueableInstance(instanceOptions);
    },
  });
};

export const createNodeEntry = <TValue>(
  options: {
    key: string;
  } & KeepAliveNodeDef<TValue>
): KeepAliveInstanceEntry<KeepAliveQueuedInstance<TValue>> => {
  const { key, ...instanceOptions } = options;
  return createNodeFactory({
    createDefinition() {
      return instanceOptions;
    },
  }).createEntry(key);
};

// contextual def 默认把节点重新挂回当前上下文暴露的 DOM host。
export const createContextualDef = <TValue>(options: {
  initialNodes: readonly Node[];
  readValue(nodes: readonly Node[]): TValue;
  detach?(nodes: readonly Node[]): void;
  destroy?(): void;
  initiallyActive?: boolean;
}): KeepAliveNodeDef<TValue> => {
  const { initialNodes, readValue, detach, destroy, initiallyActive } = options;
  return {
    initialNodes,
    readValue,
    adapter: keepAliveDomHostAdapter,
    resolvePreferredTarget() {
      return resolveContextualPreferred();
    },
    inferTarget(nodes) {
      return resolveMountedTarget(nodes);
    },
    detach,
    destroy,
    initiallyActive,
  };
};

export const createContextualFactory = <TValue>(options: {
  initialNodes: readonly Node[];
  readValue(nodes: readonly Node[]): TValue;
  detach?(nodes: readonly Node[]): void;
  destroy?(): void;
  initiallyActive?: boolean;
}): KeepAliveNodeFactory<TValue> => {
  // contextual factory 不固化 target，而是在实例创建时始终从当前 DOM host 上下文重新解析。
  return createNodeFactory<TValue>({
    createDefinition() {
      return createContextualDef(options);
    },
  });
};

export const createContextualEntry = <TValue>(options: {
  key: string;
  initialNodes: readonly Node[];
  readValue(nodes: readonly Node[]): TValue;
  detach?(nodes: readonly Node[]): void;
  destroy?(): void;
  initiallyActive?: boolean;
}): KeepAliveInstanceEntry<KeepAliveQueuedInstance<TValue>> => {
  const { key, ...definitionOptions } = options;
  return createContextualFactory(definitionOptions).createEntry(key);
};
