/**
 * KeepAlive runtime 共享状态与 bucket 存储。
 *
 * 这层不直接负责节点搬运，而是为上层 activation/host 逻辑提供几块可复用基建：
 * - 当前 active entry 与 uncached instance 的轻量状态容器；
 * - bucket store、共享单例以及按 scope 惰性建桶；
 * - instance 到 lifecycle 接口的适配桥接，统一 update/activate/deactivate/evict 调用面。
 *
 * 如果说 `cache-state.ts` 关注“本轮命中了谁”，这里更关注“这些状态被放在哪、如何跨多次渲染稳定复用”。
 */
import {
  type KeepAliveBucket,
  type KeepAliveBucketEntry,
  type KeepAliveLifecycle,
  type KeepAliveInstance,
  type KeepAliveInstanceEntry,
  type KeepAliveCallbacks,
  type KeepAliveActiveState,
  type KeepAliveUncachedState,
} from '../types';
import { clearActiveEntryForKey } from './cache-state';

// active state 只记录“当前正在激活的 bucket/key/回调”，初始化时全部为空。
export const createActiveState = <
  TEntry extends KeepAliveBucketEntry,
  TValue = unknown,
>(): KeepAliveActiveState<TEntry, TValue> => {
  return {
    bucket: null,
    key: null,
    onDeactivate: undefined,
  };
};

// 彻底清空 active state，本地状态和 bucket 状态解耦后都统一回到 null。
export const resetActiveState = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(
  state: KeepAliveActiveState<TEntry, TValue>
): void => {
  state.bucket = null;
  state.key = null;
  state.onDeactivate = undefined;
};

// 当某个 key 成为当前激活项时，把 bucket/key 和 onDeactivate 回调同步进 active state。
export const syncActiveState = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(options: {
  state: KeepAliveActiveState<TEntry, TValue>;
  bucket: KeepAliveBucket<TEntry>;
  key: string;
  callbacks?: KeepAliveCallbacks<TValue>;
}): void => {
  const { state, bucket, key, callbacks } = options;
  state.bucket = bucket;
  state.key = key;
  state.onDeactivate = callbacks?.onDeactivate;
};

// 清理当前 active state，同时尽量通过 bucket + key 定位真实激活项并触发 deactivate。
export const clearActiveState = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(options: {
  state: KeepAliveActiveState<TEntry, TValue>;
  lifecycle: KeepAliveLifecycle<TEntry, TValue>;
}): boolean => {
  const { state, lifecycle } = options;
  const didClear = clearActiveEntryForKey({
    bucket: state.bucket,
    activeKey: state.key,
    lifecycle,
    onDeactivate: state.onDeactivate,
  });
  resetActiveState(state);
  return didClear;
};

// 把具体 KeepAlive instance 适配成统一 lifecycle 接口，供缓存状态机调用。
export const createInstanceLifecycle = <
  TValue,
  TInstance extends KeepAliveInstance<TValue>,
  TEntry extends KeepAliveInstanceEntry<TInstance>,
>(): KeepAliveLifecycle<TEntry, TValue> => {
  return {
    readValue(entry) {
      return entry.instance.readValue();
    },
    readNodes(entry) {
      return entry.instance.readNodes();
    },
    isActive(entry) {
      return entry.instance.isActive?.() ?? false;
    },
    isMounted(entry) {
      return entry.instance.isMounted?.() ?? false;
    },
    update(entry) {
      entry.instance.update?.();
    },
    activate(entry) {
      entry.instance.activate();
    },
    deactivate(entry) {
      entry.instance.deactivate();
    },
    evict(entry) {
      // 被驱逐的 entry 最终走 destroy，而不是单纯 deactivate。
      entry.instance.destroy();
    },
  };
};

// 创建一套可复用的 runtime state：包含 bucket store、lifecycle 以及测试/重置入口。
export const createRuntimeState = <
  TValue,
  TInstance extends KeepAliveInstance<TValue>,
  TEntry extends KeepAliveInstanceEntry<TInstance>,
>() => {
  // buckets 与 lifecycle 成对创建，确保同一套 runtime state 内的 entry 读写规则完全一致。
  const buckets = createBucketStore<TEntry>();
  const lifecycle = createInstanceLifecycle<TValue, TInstance, TEntry>();
  return {
    buckets,
    lifecycle,
    reset() {
      buckets.clear();
    },
  };
};

// uncached 分支只需要记住“当前是否有一个未缓存实例在手上”。
export const createUncachedState = <TInstance>(): KeepAliveUncachedState<TInstance> => {
  return {
    current: null,
  };
};

// bucket store 以 scope 为 key，内部再维护 entry map 和 activeKey。
export const createBucketStore = <TEntry extends KeepAliveBucketEntry>(): Map<
  string,
  KeepAliveBucket<TEntry>
> => {
  return new Map();
};

// 共享单例放在模块级，保证不同入口导入 KeepAlive 时仍复用同一批 bucket。
// 它放在 bucket helper 之后声明，避免初始化时触发 TDZ。
export type SharedKeepAliveValue = readonly Node[];
export type SharedKeepAliveInstance = KeepAliveInstance<SharedKeepAliveValue>;
export type SharedKeepAliveEntry = KeepAliveInstanceEntry<SharedKeepAliveInstance>;

const sharedKeepAliveRuntimeState = createRuntimeState<
  SharedKeepAliveValue,
  SharedKeepAliveInstance,
  SharedKeepAliveEntry
>();

export const sharedKeepAliveBuckets = sharedKeepAliveRuntimeState.buckets;
export const sharedKeepAliveEntryLifecycle = sharedKeepAliveRuntimeState.lifecycle;

export const __resetSharedKeepAliveStateForTests = (): void => {
  sharedKeepAliveRuntimeState.reset();
};

// 按 scope 读取 bucket，不存在则惰性创建。
export const getKeepAliveBucket = <TEntry extends KeepAliveBucketEntry>(
  store: Map<string, KeepAliveBucket<TEntry>>,
  scope: string
): KeepAliveBucket<TEntry> => {
  const existing = store.get(scope);

  if (existing) {
    return existing;
  }

  // bucket 内部同时保存 entries、activeKey 和 callbacks，后续 activation 只需围绕这一处状态读写。
  const created: KeepAliveBucket<TEntry> = {
    entries: new Map(),
    activeKey: null,
    callbacksByKey: new Map(),
    activeCallbacks: undefined,
  };
  store.set(scope, created);
  return created;
};

// 通过 bucket.activeKey 读取当前激活项本体；若 key 已失效则安全回退为 null。
export const readKeepAliveActiveEntry = <TEntry extends KeepAliveBucketEntry>(
  bucket: KeepAliveBucket<TEntry>
): TEntry | null => {
  return bucket.activeKey === null ? null : bucket.entries.get(bucket.activeKey) ?? null;
};

// touch 的实现很简单：删后再插，借助 Map 的插入顺序表达“最近使用”。
export const touchKeepAliveEntry = <TEntry extends KeepAliveBucketEntry>(
  bucket: KeepAliveBucket<TEntry>,
  entry: TEntry
): void => {
  bucket.entries.delete(entry.key);
  bucket.entries.set(entry.key, entry);
};
