/**
 * KeepAlive 缓存命中与激活态清理辅助。
 *
 * 这层不直接执行完整 activate 事务，而是提供几类会在 runtime/slot/registry 之间反复复用的基础判断：
 * - 当前 key 是否允许进入缓存；
 * - 当前 bucket 是否已经命中现有 entry；
 * - active entry 何时应该被安全清空并触发 deactivate；
 * - hydration 首次接管时，SSR 节点何时还能被视为“新鲜可复用”的挂载来源。
 *
 * 相比 `cache-activation.ts` 负责“命中后如何推进一次完整激活”，
 * 这里更偏“激活前先把命中态、清理条件和复用前提判断准确”。
 */
import {
  type KeepAliveBucket,
  type KeepAliveBucketEntry,
  type KeepAliveCacheState,
  type KeepAliveHitState,
  type KeepAliveLifecycle,
  type KeepAliveKeyPattern,
  type KeepAliveCallbacks,
  type KeepAliveMissState,
  type KeepAliveActiveState,
} from '../types';
import { isKeepAliveCacheable } from './runtime-options';
import { readKeepAliveActiveEntry, touchKeepAliveEntry } from './runtime-state';

// 根据 include/exclude 规则和当前 key，判断这次渲染对应的是命中、未命中还是不可缓存状态。
export const resolveCacheState = <TEntry extends KeepAliveBucketEntry>(
  bucket: KeepAliveBucket<TEntry>,
  key: string | null,
  include: KeepAliveKeyPattern,
  exclude?: KeepAliveKeyPattern
): KeepAliveCacheState<TEntry> => {
  // 先读出上一轮活跃项，后续无论命中还是不可缓存都可能需要用它做清理或 deactivate。
  const previousActive = readKeepAliveActiveEntry(bucket);

  if (!isKeepAliveCacheable(key, include, exclude)) {
    // 不可缓存时只把“上一个激活项”带回给上层，方便后续做清理。
    return {
      cacheable: false,
      previousActive,
    };
  }

  const entry = bucket.entries.get(key) ?? null;

  if (entry) {
    // 命中缓存时刷新最近使用时间/顺序，供 LRU 类策略复用。
    touchKeepAliveEntry(bucket, entry);
  }

  return {
    cacheable: true,
    key,
    previousActive,
    entry,
    reused: Boolean(entry),
  };
};

// 新建 entry 后统一注册进 bucket。
export const registerKeepAliveEntry = <TEntry extends KeepAliveBucketEntry>(
  bucket: KeepAliveBucket<TEntry>,
  entry: TEntry
): TEntry => {
  bucket.entries.set(entry.key, entry);
  return entry;
};

// 统一执行 deactivate 生命周期，并优先使用 entry 自己携带的 callbacks。
export const dispatchDeactivate = <TEntry extends KeepAliveBucketEntry, TValue>(
  entry: TEntry | null,
  lifecycle: KeepAliveLifecycle<TEntry, TValue>,
  onDeactivate?: (value: TValue, key: string) => void
): void => {
  if (!entry) {
    return;
  }

  const resolvedOnDeactivate =
    // entry 自带回调优先级更高，确保按 key 注册的钩子不会被调用方临时回调覆盖。
    (entry as TEntry & { callbacks?: KeepAliveCallbacks<TValue> }).callbacks
      ?.onDeactivate ?? onDeactivate;
  lifecycle.deactivate?.(entry);
  resolvedOnDeactivate?.(lifecycle.readValue(entry), entry.key);
};

// 清空当前 active entry，并同步擦除 bucket 上的 activeKey / activeCallbacks。
export const clearActiveEntry = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(options: {
  bucket: KeepAliveBucket<TEntry>;
  previousActive: TEntry | null;
  lifecycle: KeepAliveLifecycle<TEntry, TValue>;
  onDeactivate?: (value: TValue, key: string) => void;
}): void => {
  const { bucket, previousActive, lifecycle, onDeactivate } = options;
  dispatchDeactivate(previousActive, lifecycle, onDeactivate);
  bucket.activeKey = null;
  bucket.activeCallbacks = undefined;
};

// 仅当当前激活项的 key 与调用方提供的 activeKey 匹配时，才真正清理。
export const clearActiveEntryForKey = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(options: {
  bucket: KeepAliveBucket<TEntry> | null;
  activeKey: string | null;
  lifecycle: KeepAliveLifecycle<TEntry, TValue>;
  onDeactivate?: (value: TValue, key: string) => void;
}): boolean => {
  const { bucket, activeKey, lifecycle, onDeactivate } = options;
  if (bucket === null || activeKey === null) {
    return false;
  }

  const previousActive = readKeepAliveActiveEntry(bucket);
  // 只允许清理“此刻仍然匹配 activeKey 的激活项”，避免延迟收尾误伤已切走的新 entry。
  if (!previousActive || previousActive.key !== activeKey) {
    return false;
  }

  clearActiveEntry({
    bucket,
    previousActive,
    lifecycle,
    onDeactivate,
  });
  return true;
};

// 不可缓存分支下，如果之前确实有 active entry，需要把它正常 deactivate 并清空激活态。
export const clearNonCacheableState = <
  TEntry extends KeepAliveBucketEntry,
  TValue,
>(options: {
  bucket: KeepAliveBucket<TEntry>;
  cacheState: KeepAliveMissState<TEntry>;
  lifecycle: KeepAliveLifecycle<TEntry, TValue>;
  callbacks?: KeepAliveCallbacks<TValue>;
}): boolean => {
  const { bucket, cacheState, lifecycle, callbacks } = options;
  if (!cacheState.previousActive) {
    return false;
  }

  clearActiveEntry({
    bucket,
    previousActive: cacheState.previousActive,
    lifecycle,
    onDeactivate: callbacks?.onDeactivate,
  });
  return true;
};

// hydration 首次接管时，只有“当前没有命中缓存、确实带着 SSR 节点、且还未进入激活态”的场景，
// 才允许把这些节点视为 fresh hydrated nodes 继续复用。
export const resolveFreshHydratedNodes = <
  TEntry extends KeepAliveBucketEntry,
  TValue = unknown,
>(options: {
  cacheState: KeepAliveHitState<TEntry>;
  hydratedNodes: readonly Node[] | null;
  activeState: KeepAliveActiveState<TEntry, TValue>;
}): readonly Node[] | null => {
  const { cacheState, hydratedNodes, activeState } = options;
  if (cacheState.entry !== null) {
    return null;
  }
  if (!hydratedNodes) {
    return null;
  }
  if (activeState.bucket !== null || activeState.key !== null) {
    return null;
  }
  return hydratedNodes;
};
