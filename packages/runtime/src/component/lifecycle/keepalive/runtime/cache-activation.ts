/**
 * KeepAlive 缓存激活主流程。
 *
 * 该文件把 KeepAlive 在运行时会发生的几件事拆成可组合步骤：
 * - 命中或新建缓存项，并把 entry 注册回 bucket；
 * - 计算当前 entry 是“仅更新”还是“需要重新激活”；
 * - 在本地模式或父容器模式下同步节点位置；
 * - 触发 activate / deactivate / cache / evict 等生命周期与回调；
 * - 在超过 `max` 限制时按 LRU 风格驱逐非活跃 entry。
 *
 * 上层实现通常只关心“本次要激活哪个 key”，本文件负责把状态迁移、
 * 节点复用和用户回调拼成一次完整的 activation 事务。
 * 其中最容易出错的是两类边界：
 * - “复用但不必重新挂载”与“必须重新激活”的判定要和 activeKey/宿主位置保持一致；
 * - 容量淘汰必须发生在新 activeKey 落定之后，避免当前命中项被同轮误驱逐。
 *
 * 为了让这些规则可复用，文件把完整流程拆成三段：
 * - `ensure/finalizeActivation` 处理 bucket、activeKey 与回调登记；
 * - `prepare/sync/runtime.sync` 处理节点是否需要重新挂载；
 * - `dispatchActivate/dispatchEvict/...` 统一派发生命周期与用户回调。
 */
import {
  type KeepAliveActivation,
  type KeepAliveBucket,
  type KeepAliveBucketEntry,
  type KeepAliveHitState,
  type KeepAliveLifecycle,
  type KeepAliveHostCommitter,
  type KeepAliveCallbacks,
} from '../types';
import { registerKeepAliveEntry } from './cache-state';

const readBucketCallbacks = <TEntry extends KeepAliveBucketEntry, TValue>(
  bucket: KeepAliveBucket<TEntry>,
  key: string
): KeepAliveCallbacks<TValue> | undefined => {
  return bucket.callbacksByKey.get(key) as KeepAliveCallbacks<TValue> | undefined;
};

const syncBucketCallbacks = <TEntry extends KeepAliveBucketEntry, TValue>(
  bucket: KeepAliveBucket<TEntry>,
  key: string,
  callbacks?: KeepAliveCallbacks<TValue>
): void => {
  if (!callbacks) {
    // 调用方本轮未提供回调时，要把旧 key 绑定的监听一并移除，避免后续误复用。
    bucket.callbacksByKey.delete(key);
    return;
  }
  bucket.callbacksByKey.set(key, callbacks as KeepAliveCallbacks<unknown>);
};

export const activateKeepAliveEntry = <TEntry extends KeepAliveBucketEntry>(
  bucket: KeepAliveBucket<TEntry>,
  entry: TEntry,
  previousActive: TEntry | null,
  max: number
): {
  deactivatedEntry: TEntry | null;
  evictedEntries: TEntry[];
} => {
  // 先更新活跃 key，再根据容量约束驱逐最旧且非当前活跃的缓存项。
  bucket.activeKey = entry.key;

  return {
    deactivatedEntry:
      previousActive && previousActive.key !== entry.key ? previousActive : null,
    evictedEntries: evictKeepAliveEntries(bucket, max, entry.key),
  };
};

const dispatchDeactivateInternal = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(
  entry: TEntry | null,
  lifecycle: KeepAliveLifecycle<TEntry, TValue>,
  callbacks?: KeepAliveCallbacks<TValue>,
  onDeactivate?: (value: TValue, key: string) => void
): void => {
  if (!entry) {
    return;
  }

  // 允许调用方传入一次性回调，也允许复用 bucket 中随 key 挂着的持久回调。
  const resolvedOnDeactivate = callbacks?.onDeactivate ?? onDeactivate;
  lifecycle.deactivate?.(entry);
  resolvedOnDeactivate?.(lifecycle.readValue(entry), entry.key);
};

export const dispatchKeepAliveUpdate = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(
  entry: TEntry,
  lifecycle: KeepAliveLifecycle<TEntry, TValue>
): void => {
  // update 与 activate 分离，便于“仍是当前活跃项”的场景只做增量刷新。
  lifecycle.update?.(entry);
};

export const resolveReuseAction = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(options: {
  entry: TEntry;
  lifecycle: KeepAliveLifecycle<TEntry, TValue>;
  parent?: Node;
  activeKeyChanged: boolean;
}): {
  shouldUpdate: boolean;
  shouldActivate: boolean;
} => {
  const { entry, lifecycle, parent, activeKeyChanged } = options;
  const shouldUpdate = !activeKeyChanged;

  if (!parent) {
    // 本地模式没有父容器可比对，只依据 activeKey 是否变化和 entry 当前激活态决定。
    return {
      shouldUpdate,
      shouldActivate: activeKeyChanged || !(lifecycle.isActive?.(entry) ?? false),
    };
  }

  return {
    shouldUpdate,
    // 父容器模式下是否“需要重新激活”取决于 activeKey、entry 激活态和节点宿主位置三者。
    shouldActivate: shouldActivateInParent({
      entry,
      lifecycle,
      parent,
      activeKeyChanged,
    }),
  };
};

export const prepareEntryForReuse = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(options: {
  entry: TEntry;
  lifecycle: KeepAliveLifecycle<TEntry, TValue>;
  activeKeyChanged: boolean;
  parent?: Node;
  updateEntry?(entry: TEntry): void;
}): {
  nodes: readonly Node[];
  shouldActivate: boolean;
} => {
  const { entry, lifecycle, activeKeyChanged, parent, updateEntry } = options;
  const reuseAction = resolveReuseAction({
    entry,
    lifecycle,
    parent,
    activeKeyChanged,
  });

  if (reuseAction.shouldUpdate) {
    // 复用同一 activeKey 时优先走 update，避免把本可增量更新的 entry 当成全新激活处理。
    if (updateEntry) {
      updateEntry(entry);
    } else {
      dispatchKeepAliveUpdate(entry, lifecycle);
    }
  }

  return {
    nodes: lifecycle.readNodes?.(entry) ?? [],
    shouldActivate: reuseAction.shouldActivate,
  };
};

export const syncEntryInParent = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(options: {
  entry: TEntry;
  lifecycle: KeepAliveLifecycle<TEntry, TValue>;
  parent: Node;
  activeKeyChanged: boolean;
  updateEntry?(entry: TEntry): void;
  host?: KeepAliveHostCommitter;
  mountNodes?(nodes: readonly Node[]): void;
  syncNodes?(nodes: readonly Node[]): void;
}): {
  nodes: readonly Node[];
  didActivate: boolean;
} => {
  const {
    entry,
    lifecycle,
    parent,
    activeKeyChanged,
    updateEntry,
    host,
    mountNodes,
    syncNodes,
  } = options;
  const { nodes, shouldActivate } = prepareEntryForReuse({
    entry,
    lifecycle,
    activeKeyChanged,
    parent,
    updateEntry,
  });
  const didActivate = shouldActivate;

  if (didActivate) {
    // 父容器模式下，激活意味着把 entry 的节点重新提交到宿主位置。
    if (host) {
      host.commit(nodes);
    } else {
      mountNodes?.(nodes);
    }
  }

  if (host && !didActivate) {
    // 已经处于正确位置时只做同步，不重复提交，避免额外 DOM 扰动。
    host.sync(nodes);
  } else if (!host) {
    syncNodes?.(nodes);
  }

  return {
    nodes,
    didActivate,
  };
};

export const createLocalActivationRuntime = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(): KeepAliveActivation<TEntry, TValue> => {
  return {
    sync({ entry, lifecycle, created, activeKeyChanged, updateEntry }) {
      if (created) {
        // 新建 entry 默认视为刚刚激活，不需要再额外判断 mounted/active。
        return { didActivate: true };
      }
      return {
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

export const createParentActivation = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(options: {
  parent: Node;
  host?: KeepAliveHostCommitter;
}): KeepAliveActivation<TEntry, TValue> => {
  const { parent, host } = options;
  return {
    sync({ entry, lifecycle, activeKeyChanged, updateEntry }) {
      // 父容器模式复用同一套 syncEntryInParent，把宿主提交能力外部注入进来。
      return syncEntryInParent({
        entry,
        lifecycle,
        parent,
        activeKeyChanged,
        updateEntry,
        host,
      });
    },
  };
};

export const finalizeActivatedEntry = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(options: {
  bucket: KeepAliveBucket<TEntry>;
  entry: TEntry;
  lifecycle: KeepAliveLifecycle<TEntry, TValue>;
  didActivate: boolean;
  reused: boolean;
  evictedEntries: readonly TEntry[];
  onActivate?: (value: TValue, key: string, reused: boolean) => void;
  onEvict?: (value: TValue, key: string) => void;
}): void => {
  const {
    bucket,
    entry,
    lifecycle,
    didActivate,
    reused,
    evictedEntries,
    onActivate,
    onEvict,
  } = options;

  if (didActivate) {
    // 只有真正进入激活态时才派发 activate；纯 update 不重复触发该生命周期。
    dispatchActivate(entry, lifecycle, onActivate, reused);
  }

  // 淘汰发生在本次激活之后，确保“当前激活项”不会被同一轮容量检查误删。
  dispatchEvictions({
    entries: evictedEntries,
    lifecycle,
    bucket,
    onEvict,
  });
};

export const activateCacheEntry = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(options: {
  bucket: KeepAliveBucket<TEntry>;
  cacheState: KeepAliveHitState<TEntry>;
  max: number;
  lifecycle: KeepAliveLifecycle<TEntry, TValue>;
  callbacks?: KeepAliveCallbacks<TValue>;
  activeKeyChanged: boolean;
  updateEntry?(entry: TEntry): void;
  createEntry?: () => TEntry;
  runtime?: KeepAliveActivation<TEntry, TValue>;
}): {
  entry: TEntry;
  created: boolean;
} => {
  const {
    bucket,
    cacheState,
    max,
    lifecycle,
    callbacks,
    activeKeyChanged,
    updateEntry,
    createEntry,
    runtime = createLocalActivationRuntime<TEntry, TValue>(),
  } = options;
  const { entry, created, evictedEntries, reused } = ensureActivatedEntry({
    bucket,
    cacheState,
    max,
    lifecycle,
    callbacks,
    createEntry,
  });

  // 先让 runtime 决定宿主节点是否要真正“激活/挂回”，再统一收口生命周期派发。
  // runtime.sync 只负责“节点/挂载位置”层面的同步，生命周期派发统一放到 finalize。
  // 这样 parent-host、本地 runtime、未来的其他宿主实现都能复用同一套生命周期约束。
  const { didActivate } = runtime.sync({
    entry,
    lifecycle,
    created,
    activeKeyChanged,
    updateEntry,
  });

  finalizeActivatedEntry({
    bucket,
    entry,
    lifecycle,
    didActivate,
    reused,
    evictedEntries,
    onActivate: callbacks?.onActivate,
    onEvict: callbacks?.onEvict,
  });

  return {
    entry,
    created,
  };
};

export const reuseActivatedEntry = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(options: {
  bucket: KeepAliveBucket<TEntry>;
  cacheState: KeepAliveHitState<TEntry>;
  max: number;
  lifecycle: KeepAliveLifecycle<TEntry, TValue>;
  callbacks?: KeepAliveCallbacks<TValue>;
  activeKeyChanged: boolean;
  updateEntry?(entry: TEntry): void;
}): TEntry => {
  const {
    bucket,
    cacheState,
    max,
    lifecycle,
    callbacks,
    activeKeyChanged,
    updateEntry,
  } = options;
  const entry = cacheState.entry;
  if (!entry) {
    throw new Error('KeepAlive reuse path requires an existing cache entry.');
  }
  return activateCacheEntry({
    bucket,
    cacheState,
    max,
    lifecycle,
    callbacks,
    activeKeyChanged,
    updateEntry,
  }).entry;
};

export const activateFreshEntry = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(options: {
  bucket: KeepAliveBucket<TEntry>;
  cacheState: KeepAliveHitState<TEntry>;
  max: number;
  lifecycle: KeepAliveLifecycle<TEntry, TValue>;
  callbacks?: KeepAliveCallbacks<TValue>;
  createEntry: () => TEntry;
}): {
  entry: TEntry;
  created: boolean;
} => {
  const {
    bucket,
    cacheState,
    max,
    lifecycle,
    callbacks,
    createEntry,
  } = options;
  return activateCacheEntry({
    bucket,
    cacheState,
    max,
    lifecycle,
    callbacks,
    activeKeyChanged: true,
    createEntry,
  });
};

export const activateEntryInParent = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(options: {
  bucket: KeepAliveBucket<TEntry>;
  cacheState: KeepAliveHitState<TEntry>;
  max: number;
  lifecycle: KeepAliveLifecycle<TEntry, TValue>;
  parent: Node;
  activeKeyChanged: boolean;
  updateEntry?(entry: TEntry): void;
  host?: KeepAliveHostCommitter;
  callbacks?: KeepAliveCallbacks<TValue>;
  createEntry?: () => TEntry;
}): {
  entry: TEntry;
  created: boolean;
} => {
  const {
    bucket,
    cacheState,
    max,
    lifecycle,
    parent,
    activeKeyChanged,
    updateEntry,
    host,
    callbacks,
    createEntry,
  } = options;
  return activateCacheEntry({
    bucket,
    cacheState,
    max,
    lifecycle,
    callbacks,
    activeKeyChanged,
    updateEntry,
    createEntry,
    runtime: createParentActivation({
      // 父容器模式把“如何把节点挂回页面”注入给通用激活流程。
      // 是否真的需要挂回，会在 shouldActivateInParent + runtime.sync 两层一起判定。
      parent,
      host,
    }),
  });
};

export const dispatchActivate = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(
  entry: TEntry,
  lifecycle: KeepAliveLifecycle<TEntry, TValue>,
  onActivate?: (value: TValue, key: string, reused: boolean) => void,
  reused = false
): void => {
  lifecycle.activate?.(entry);
  onActivate?.(lifecycle.readValue(entry), entry.key, reused);
};

export const dispatchCache = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(
  entry: TEntry,
  lifecycle: KeepAliveLifecycle<TEntry, TValue>,
  onCache?: (value: TValue, key: string) => void
): void => {
  // cache 代表条目第一次进入 bucket，不等同于每次命中或激活。
  onCache?.(lifecycle.readValue(entry), entry.key);
};

export const dispatchEvict = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(
  options: {
    bucket: KeepAliveBucket<TEntry>;
    entry: TEntry;
    lifecycle: KeepAliveLifecycle<TEntry, TValue>;
    onEvict?: (value: TValue, key: string) => void;
  }
): void => {
  const { bucket, entry, lifecycle, onEvict } = options;
  // 驱逐时优先读取 bucket 中随 key 保存的回调，保证延迟淘汰也能命中正确监听器。
  const resolvedOnEvict = readBucketCallbacks<TEntry, TValue>(bucket, entry.key)?.onEvict ?? onEvict;
  lifecycle.evict?.(entry);
  resolvedOnEvict?.(lifecycle.readValue(entry), entry.key);
  bucket.callbacksByKey.delete(entry.key);
};

export const dispatchEvictions = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(
  options: {
    entries: readonly TEntry[];
    lifecycle: KeepAliveLifecycle<TEntry, TValue>;
    bucket: KeepAliveBucket<TEntry>;
    onEvict?: (value: TValue, key: string) => void;
  }
): void => {
  const { entries, lifecycle, bucket, onEvict } = options;
  entries.forEach((entry) => {
    dispatchEvict({
      bucket,
      entry,
      lifecycle,
      onEvict,
    });
  });
};

export const isEntryMountedInParent = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(
  entry: TEntry,
  lifecycle: KeepAliveLifecycle<TEntry, TValue>,
  parent: Node
): boolean => {
  if (lifecycle.isMounted && lifecycle.isMounted(entry) === false) {
    return false;
  }
  const nodes = lifecycle.readNodes?.(entry) ?? [];
  // 只要任一节点仍在目标父容器下，就认为该 entry 还占据着正确宿主位置。
  return nodes.some((node) => node.parentNode === parent);
};

export const isKeepAliveEntryActive = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(
  entry: TEntry,
  lifecycle: KeepAliveLifecycle<TEntry, TValue>
): boolean => {
  return lifecycle.isActive?.(entry) ?? false;
};

export const shouldActivateInParent = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(options: {
  entry: TEntry;
  lifecycle: KeepAliveLifecycle<TEntry, TValue>;
  parent: Node;
  activeKeyChanged: boolean;
}): boolean => {
  const { entry, lifecycle, parent, activeKeyChanged } = options;
  if (activeKeyChanged) {
    return true;
  }

  if (!isKeepAliveEntryActive(entry, lifecycle)) {
    return true;
  }

  // 即便 entry 自身标记为 active，只要节点已经不在目标父容器下，也需要重新激活挂回去。
  // 这里把“活跃态”和“宿主位置正确”拆成两个条件，避免仅凭 active 标记误判为可复用。
  return !isEntryMountedInParent(entry, lifecycle, parent);
};

export const finalizeActivation = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(options: {
  bucket: KeepAliveBucket<TEntry>;
  entry: TEntry;
  previousActive: TEntry | null;
  max: number;
  lifecycle: KeepAliveLifecycle<TEntry, TValue>;
  onDeactivate?: (value: TValue, key: string) => void;
  callbacks?: KeepAliveCallbacks<TValue>;
}): {
  deactivatedEntry: TEntry | null;
  evictedEntries: TEntry[];
} => {
  const { bucket, entry, previousActive, max, lifecycle, onDeactivate, callbacks } = options;
  const previousCallbacks = bucket.activeCallbacks as KeepAliveCallbacks<TValue> | undefined;
  // 激活 entry 本身会顺带推进 activeKey，并算出谁需要停用、谁需要被驱逐。
  const { deactivatedEntry, evictedEntries } = activateKeepAliveEntry(
    bucket,
    entry,
    previousActive,
    max
  );

  // old active entry 的停用与新 active entry 的登记属于同一状态切换步骤。
  dispatchDeactivateInternal(deactivatedEntry, lifecycle, previousCallbacks, onDeactivate);
  // activeCallbacks 始终跟随 bucket.activeKey 一起切换，供后续延迟停用/驱逐读取到最新监听器。
  bucket.activeCallbacks = callbacks as KeepAliveCallbacks<unknown> | undefined;

  return {
    deactivatedEntry,
    evictedEntries,
  };
};

export const ensureActivatedEntry = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(options: {
  bucket: KeepAliveBucket<TEntry>;
  cacheState: KeepAliveHitState<TEntry>;
  max: number;
  lifecycle: KeepAliveLifecycle<TEntry, TValue>;
  callbacks?: KeepAliveCallbacks<TValue>;
  createEntry?: () => TEntry;
}): {
  entry: TEntry;
  created: boolean;
  evictedEntries: TEntry[];
  reused: boolean;
} => {
  const { bucket, cacheState, max, lifecycle, callbacks, createEntry } = options;
  let entry = cacheState.entry;
  let created = false;

  if (!entry) {
    if (!createEntry) {
      throw new Error('KeepAlive cacheable state requires createEntry() when entry is absent.');
    }
    // 未命中缓存时在这里补建 entry，之后通用激活逻辑就不需要区分新旧来源。
    entry = registerKeepAliveEntry(bucket, createEntry());
    created = true;
  }

  // bucket 级 callbacks 与 entry.key 绑定保存，供后续异步停用/驱逐仍能拿到正确监听器。
  syncBucketCallbacks(bucket, entry.key, callbacks);

  if (created) {
    // `cache` 语义只在首次进入 bucket 时触发一次。
    dispatchCache(entry, lifecycle, callbacks?.onCache);
  }

  // 这里会顺带完成 activeKey 切换、旧 active 停用，以及容量淘汰。
  // 返回的 evictedEntries 只是状态层结果，真正的 evict 生命周期要等 finalize 阶段统一派发。
  const { evictedEntries } = finalizeActivation({
    bucket,
    entry,
    previousActive: cacheState.previousActive,
    max,
    lifecycle,
    onDeactivate: callbacks?.onDeactivate,
    callbacks,
  });

  return {
    entry,
    created,
    evictedEntries,
    reused: cacheState.reused,
  };
};

export const evictKeepAliveEntries = <TEntry extends KeepAliveBucketEntry>(
  bucket: KeepAliveBucket<TEntry>,
  max: number,
  activeKey: string
): TEntry[] => {
  const evicted: TEntry[] = [];

  while (bucket.entries.size > max) {
    // Map 的迭代顺序即插入顺序，这里天然形成近似 LRU 的“最老项优先驱逐”。
    const oldestKey = bucket.entries.keys().next().value as string | undefined;

    if (!oldestKey || oldestKey === activeKey) {
      // 当前活跃项不能被逐出；若最老项恰好是 activeKey，则本轮停止淘汰。
      break;
    }

    const entry = bucket.entries.get(oldestKey);
    bucket.entries.delete(oldestKey);

    if (entry) {
      // 真正的生命周期回调不在这里触发，只先收集条目，交给外层统一派发 evict。
      evicted.push(entry);
    }
  }

  return evicted;
};
