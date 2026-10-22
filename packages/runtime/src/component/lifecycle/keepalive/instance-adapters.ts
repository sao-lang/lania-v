/**
 * 把不同来源的 KeepAlive 数据源适配成统一实例协议。
 *
 * KeepAlive 上游可能持有的“可缓存对象”形态很多：
 * - 已经挂载好的 surface；
 * - 只有一组现成 DOM 节点；
 * - 支持先排队节点、稍后再接管的 queued surface。
 *
 * 本文件的目标是把这些差异统一收敛成最小实例接口：
 * `readValue/readNodes/update/activate/deactivate/destroy/isMounted/isActive`。
 * 后续缓存命中、激活、驱逐逻辑只面向这套协议，而不需要关心来源细节。
 */
import {
  detachKeepAliveNodes,
  type KeepAliveInstance,
  type KeepAliveLifecycleHooks,
  type KeepAliveSurface,
  type KeepAliveMountedFactory,
  type KeepAliveSurfaceDef,
  type KeepAliveQueuedInstance,
  type KeepAliveQueuedSurface,
  type KeepAliveHookSource,
} from './types';

// 最基础的实例适配器，仅在闭包里维护 active 状态并委托生命周期回调。
export const createInstanceAdapter = <TValue>(options: {
  readValue(): TValue;
  readNodes(): readonly Node[];
  update?(): void;
  activate?(): void;
  deactivate?(): void;
  destroy?(): void;
  isMounted?(): boolean;
  initiallyActive?: boolean;
}): KeepAliveInstance<TValue> => {
  const {
    readValue,
    readNodes,
    update,
    activate,
    deactivate,
    destroy,
    isMounted,
    initiallyActive = false,
  } = options;
  let active = initiallyActive;

  return {
    readValue,
    readNodes,
    isActive() {
      return active;
    },
    isMounted() {
      // 未提供自定义 mounted 判定时，退回到“是否仍挂在文档树中”的朴素检查。
      return isMounted
        ? isMounted()
        : readNodes().some((node) => node.parentNode !== null);
    },
    update,
    activate() {
      active = true;
      activate?.();
    },
    deactivate() {
      active = false;
      deactivate?.();
    },
    destroy() {
      active = false;
      destroy?.();
    },
  };
};

// 钩子适配器负责把缓存条目值映射成调用方期待的值类型。
export const createHookAdapter = <TSourceValue, TTargetValue>(options: {
  source:
    | KeepAliveHookSource
    | KeepAliveLifecycleHooks<TSourceValue>
    | null
    | undefined;
  mapValue(value: TTargetValue): TSourceValue;
}): KeepAliveLifecycleHooks<TTargetValue> => {
  const { source, mapValue } = options;
  const onActivate =
    typeof source?.onActivate === 'function' ? source.onActivate : undefined;
  const onDeactivate =
    typeof source?.onDeactivate === 'function'
      ? source.onDeactivate
      : undefined;
  const onCache =
    typeof source?.onCache === 'function' ? source.onCache : undefined;
  const onEvict =
    typeof source?.onEvict === 'function' ? source.onEvict : undefined;

  return {
    onActivate: onActivate
      ? (value: TTargetValue, key: string, reused: boolean) =>
          onActivate(mapValue(value), key, reused)
      : undefined,
    onDeactivate: onDeactivate
      ? (value: TTargetValue, key: string) => onDeactivate(mapValue(value), key)
      : undefined,
    onCache: onCache
      ? (value: TTargetValue, key: string) => onCache(mapValue(value), key)
      : undefined,
    onEvict: onEvict
      ? (value: TTargetValue, key: string) => onEvict(mapValue(value), key)
      : undefined,
  };
};

// 纯节点实例不需要 update/activate，只需在失活与销毁时把节点摘除。
export const createNodeBackedKeepAliveInstance = <TValue>(options: {
  nodes: readonly Node[];
  readValue(nodes: readonly Node[]): TValue;
}): KeepAliveInstance<TValue> => {
  const { nodes, readValue } = options;
  const value = readValue(nodes);
  return createInstanceAdapter<TValue>({
    readValue() {
      return value;
    },
    readNodes() {
      return nodes;
    },
    update() {},
    deactivate() {
      detachKeepAliveNodes(nodes);
    },
    destroy() {
      detachKeepAliveNodes(nodes);
    },
  });
};

// surface instance 直接把 mounted surface 暴露的行为映射到实例协议。
export const createSurfaceInstance = <
  TValue,
  TMounted extends KeepAliveSurface,
  TInstance extends KeepAliveInstance<TValue> = KeepAliveInstance<TValue>,
>(
  options: KeepAliveSurfaceDef<TValue, TMounted, TInstance>
): TInstance => {
  const { readValue, mounted, initiallyActive = false } = options;
  const instance = createInstanceAdapter<TValue>({
    readValue,
    readNodes() {
      return mounted.readNodes();
    },
    isMounted() {
      return mounted.isMounted();
    },
    update() {
      mounted.update();
    },
    activate() {
      mounted.activate();
    },
    deactivate() {
      mounted.detach();
    },
    destroy() {
      mounted.destroy();
    },
    initiallyActive,
  });

  return options.extend
    ? options.extend(instance, mounted)
    : (instance as TInstance);
};

export const createMountedInstance = <TValue>(options: {
  readValue(): TValue;
  mounted: KeepAliveSurface;
  initiallyActive?: boolean;
}): KeepAliveInstance<TValue> => {
  return createSurfaceInstance(options);
};

export const createMountedRecord = <
  TValue,
  TMounted extends KeepAliveSurface,
  TInstance extends KeepAliveInstance<TValue>,
>(options: {
  readValue(): TValue;
  mounted: TMounted;
  initiallyActive?: boolean;
  createInstance(options: {
    readValue(): TValue;
    mounted: TMounted;
    initiallyActive?: boolean;
  }): TInstance;
}): {
  mounted: TMounted;
  instance: TInstance;
} => {
  const { readValue, mounted, initiallyActive, createInstance } = options;
  // 把 mounted surface 与派生出的 instance 成对返回，便于调用方同时保留两层引用。
  return {
    mounted,
    instance: createInstance({
      readValue,
      mounted,
      initiallyActive,
    }),
  };
};

export const createMountedFactory = <
  TValue,
  TMounted extends KeepAliveSurface,
  TInstance extends KeepAliveInstance<TValue>,
>(options: {
  createRecordOptions(): {
    readValue(): TValue;
    mounted: TMounted;
    initiallyActive?: boolean;
  };
  createInstance(options: {
    readValue(): TValue;
    mounted: TMounted;
    initiallyActive?: boolean;
  }): TInstance;
}): KeepAliveMountedFactory<TValue, TMounted, TInstance> => {
  const { createRecordOptions, createInstance } = options;
  const createRecord = () =>
    createMountedRecord<TValue, TMounted, TInstance>({
      ...createRecordOptions(),
      createInstance,
    });

  return {
    createRecord,
    createInstance() {
      // 便捷入口：只拿实例，不关心 mounted surface 时可直接走这里。
      return createRecord().instance;
    },
    createEntry(key: string) {
      return {
        key,
        instance: createRecord().instance,
      };
    },
  };
};

// 带队列的实例在基础协议上附加 `queueNodes()`，供缓存命中前先排队节点。
export const createQueueableInstance = <TValue>(options: {
  readValue(): TValue;
  mounted: KeepAliveQueuedSurface;
  initiallyActive?: boolean;
}): KeepAliveQueuedInstance<TValue> => {
  return createSurfaceInstance<
    TValue,
    KeepAliveQueuedSurface,
    KeepAliveQueuedInstance<TValue>
  >({
    ...options,
    extend(instance, mounted) {
      // queued surface 在基础实例协议上额外挂出 queueNodes，供激活前暂存节点。
      return Object.assign(instance, {
        queueNodes(nodes: readonly Node[]) {
          mounted.queueNodes(nodes);
        },
      });
    },
  });
};

export const createQueuedMounted = <TValue>(options: {
  readValue(): TValue;
  mounted: KeepAliveQueuedSurface;
  initiallyActive?: boolean;
}): {
  mounted: KeepAliveQueuedSurface;
  instance: KeepAliveQueuedInstance<TValue>;
} => {
  return createMountedFactory<
    TValue,
    KeepAliveQueuedSurface,
    KeepAliveQueuedInstance<TValue>
  >({
    createRecordOptions() {
      return options;
    },
    createInstance(instanceOptions) {
      return createQueueableInstance(instanceOptions);
    },
  }).createRecord();
};
