/**
 * KeepAlive 宿主运行时控制器。
 *
 * 该文件负责把 KeepAlive 的缓存激活逻辑接到真实 DOM 宿主环境里，并统一暴露一套
 * `KeepAliveRuntimeController` 接口。根据宿主可见锚点的不同，运行时拆成两种模式：
 * - anchored：有稳定锚点节点，激活时总能回落到该锚点所在父容器；
 * - contextual：没有固定锚点，而是按当前上下文动态推断真实挂载目标。
 *
 * 两种控制器共享的核心职责包括：
 * - 维护当前 active key / hydrated nodes / uncached instance 状态；
 * - 把缓存 entry 的“复用、重新激活、替换为 uncached”映射成宿主提交动作；
 * - 在销毁时同步回收活动状态与宿主侧缓存。
 *
 * 这个文件本身不决定 cache entry 如何创建或淘汰，它只负责把 keepalive 的状态迁移
 * 落实到宿主节点层：什么时候能定位父容器、什么时候只能延迟判断、以及何时要把
 * uncached 实例直接接管成当前可见节点。
 */
import type {
  KeepAliveActivation,
  KeepAliveRuntimeController,
  KeepAliveBucketEntry,
  KeepAliveLifecycle,
  KeepAliveHostAdapter,
  KeepAliveHostTarget,
} from '../types';
import {
  clearActiveState,
  createActiveState,
  syncActiveState,
} from '../runtime/runtime-state';
import {
  createParentActivation,
  prepareEntryForReuse,
  syncEntryInParent,
} from '../runtime/cache-activation';
import {
  createAnchoredNodeHost,
  createContextualNodeHost,
  createUncachedController,
} from './host-controller';

export const createAnchoredRuntimeController = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
  TInstance,
>(options: {
  anchor: Node;
  acquireNodes(): Node[];
  releaseNodes(nodes: Node[]): void;
  lifecycle: KeepAliveLifecycle<TEntry, TValue>;
  destroyInstance(instance: TInstance): void;
  readInstanceNodes(instance: TInstance): readonly Node[];
  adapter?: KeepAliveHostAdapter;
  inferTarget?(nodes: readonly Node[]): KeepAliveHostTarget | null;
}): KeepAliveRuntimeController<TEntry, TValue, TInstance> => {
  const {
    anchor,
    acquireNodes,
    releaseNodes,
    lifecycle,
    destroyInstance,
    readInstanceNodes,
    adapter,
    inferTarget,
  } = options;
  // anchored 模式围绕固定锚点构建宿主，适合普通结构性 slot 的稳定挂载场景。
  const hostRuntime = createAnchoredNodeHost({
    anchor,
    acquireNodes,
    releaseNodes,
    adapter,
    inferTarget,
  });
  // activeState 只保存“当前激活的是谁”，真正的 entry 数据仍归 bucket/lifecycle 管理。
  const activeState = createActiveState<TEntry, TValue>();
  const uncachedController = createUncachedController<TInstance>({
    destroy: destroyInstance,
    readNodes: readInstanceNodes,
    host: hostRuntime.host,
  });

  return {
    hostRuntime,
    activeState,
    uncachedController,
    readParent() {
      return anchor.parentNode;
    },
    createActivationRuntime() {
      const parent = anchor.parentNode;
      if (!parent) {
        // 锚点当前未接入 DOM 时，无法生成“挂回父容器”的激活运行时。
        return null;
      }
      return createParentActivation<TEntry, TValue>({
        parent,
        host: hostRuntime.host,
      });
    },
    readHostTarget() {
      return hostRuntime.readHostTarget();
    },
    readHydratedNodes() {
      return hostRuntime.hostState.readHydratedNodes();
    },
    clearHydrated() {
      hostRuntime.hostState.clearHydrated();
    },
    hasActiveKeyChanged(key: string) {
      return activeState.key !== key;
    },
    replaceWithUncached(instance) {
      // 切到 uncached 路径时，先让宿主接管新实例节点，再清空 active cache 状态。
      const nodes = uncachedController.replace(instance);
      clearActiveState({
        state: activeState,
        lifecycle,
      });
      hostRuntime.hostState.clearHydrated();
      return nodes;
    },
    clearUncached() {
      return uncachedController.clear();
    },
    clearActive() {
      return clearActiveState({
        state: activeState,
        lifecycle,
      });
    },
    syncActive(bucket, key, callbacks) {
      syncActiveState({
        state: activeState,
        bucket,
        key,
        callbacks,
      });
    },
    destroy() {
      uncachedController.clear();
      clearActiveState({
        state: activeState,
        lifecycle,
      });
      hostRuntime.hostState.destroy();
    },
  };
};

const createContextualActivationRuntime = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(options: {
  lifecycle: KeepAliveLifecycle<TEntry, TValue>;
  readHostTarget(): KeepAliveHostTarget | null;
  host: KeepAliveRuntimeController<
    TEntry,
    TValue,
    unknown
  >['hostRuntime']['host'];
}): KeepAliveActivation<TEntry, TValue> => {
  const { lifecycle, readHostTarget, host } = options;
  return {
    sync({ entry, created, activeKeyChanged, updateEntry }) {
      if (created) {
        // 新建 entry 的首次激活不需要再做“是否复用”的判定。
        return { didActivate: true };
      }

      const target = readHostTarget();
      if (!activeKeyChanged && target) {
        // 仍是同一个 activeKey 且能定位到宿主目标时，优先执行父容器内同步。
        return syncEntryInParent({
          entry,
          lifecycle,
          parent: target.parent,
          activeKeyChanged: false,
          updateEntry,
          host,
        });
      }

      return {
        // 若目标尚不可得，则退回纯状态判断，只决定本轮是否应视作重新激活。
        didActivate: prepareEntryForReuse({
          entry,
          lifecycle,
          activeKeyChanged,
          updateEntry,
        }).shouldActivate,
      };
    },
  };
};

export const createContextualRuntimeController = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
  TInstance,
>(options: {
  lifecycle: KeepAliveLifecycle<TEntry, TValue>;
  destroyInstance(instance: TInstance): void;
  readInstanceNodes(instance: TInstance): readonly Node[];
  adapter?: KeepAliveHostAdapter;
  inferTarget?(nodes: readonly Node[]): KeepAliveHostTarget | null;
}): KeepAliveRuntimeController<TEntry, TValue, TInstance> => {
  const {
    lifecycle,
    destroyInstance,
    readInstanceNodes,
    adapter,
    inferTarget,
  } = options;
  // contextual 模式不依赖固定 anchor，而是每次根据上下文读取当前 host target。
  const hostRuntime = createContextualNodeHost({
    acquireNodes() {
      return [];
    },
    releaseNodes() {},
    adapter,
    inferTarget,
  });
  // contextual 模式同样维护 active/uncached 状态，只是宿主目标的读取被推迟到 commit 时刻。
  const activeState = createActiveState<TEntry, TValue>();
  const uncachedController = createUncachedController<TInstance>({
    destroy: destroyInstance,
    readNodes: readInstanceNodes,
    host: hostRuntime.host,
  });

  return {
    hostRuntime,
    activeState,
    uncachedController,
    readParent() {
      return hostRuntime.readHostTarget()?.parent ?? null;
    },
    createActivationRuntime() {
      // contextual 控制器总能构造一个“延迟解析目标”的激活运行时。
      return createContextualActivationRuntime({
        lifecycle,
        readHostTarget: () => hostRuntime.readHostTarget(),
        host: hostRuntime.host,
      });
    },
    readHostTarget() {
      return hostRuntime.readHostTarget();
    },
    readHydratedNodes() {
      return hostRuntime.hostState.readHydratedNodes();
    },
    clearHydrated() {
      hostRuntime.hostState.clearHydrated();
    },
    hasActiveKeyChanged(key: string) {
      return activeState.key !== key;
    },
    replaceWithUncached(instance) {
      // uncached 替换后立即清掉 active/hydrated 语义，避免旧缓存与新实例混用。
      const nodes = uncachedController.replace(instance);
      clearActiveState({
        state: activeState,
        lifecycle,
      });
      hostRuntime.hostState.clearHydrated();
      return nodes;
    },
    clearUncached() {
      return uncachedController.clear();
    },
    clearActive() {
      return clearActiveState({
        state: activeState,
        lifecycle,
      });
    },
    syncActive(bucket, key, callbacks) {
      syncActiveState({
        state: activeState,
        bucket,
        key,
        callbacks,
      });
    },
    destroy() {
      uncachedController.clear();
      clearActiveState({
        state: activeState,
        lifecycle,
      });
      hostRuntime.hostState.destroy();
    },
  };
};
