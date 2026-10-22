/**
 * 汇总 `KeepAlive` 子系统的类型、帮助函数与默认 DOM 适配器。
 *
 * 这是 keepalive 运行时之间共享的协议文件，覆盖的层级比较广：
 * 1. 缓存命中与 bucket 管理相关的 key、entry、callbacks、active state；
 * 2. 宿主挂载相关的 target、adapter、surface、host state、runtime controller；
 * 3. 面向 source / node / mounted factory 的实例抽象与最小生命周期接口。
 *
 * 这些类型本身不承载实现逻辑，但决定了各个 keepalive 子模块之间如何协作与复用。
 */
import { type DomHostOwner } from '../../host/function-component';

// include/exclude 允许数组、正则或空值，解析阶段会进一步归一化。
export type KeepAliveKeyPattern = readonly string[] | RegExp | null | undefined;

export interface KeepAliveCacheSource {
  scope?: unknown;
  key?: unknown;
  include?: unknown;
  exclude?: unknown;
  max?: unknown;
}

export interface KeepAliveLifecycleHooks<TValue> {
  onActivate?: (value: TValue, key: string, reused: boolean) => void;
  onDeactivate?: (value: TValue, key: string) => void;
  onCache?: (value: TValue, key: string) => void;
  onEvict?: (value: TValue, key: string) => void;
}

// Source 侧允许先以宽松输入形态收集数据，后续再解析成强约束运行时选项。
export interface KeepAliveHookSource {
  onActivate?: unknown;
  onDeactivate?: unknown;
  onCache?: unknown;
  onEvict?: unknown;
}

export type KeepAliveRuntimeSource = KeepAliveCacheSource & KeepAliveHookSource;

export interface KeepAliveOptions<TValue = unknown> {
  scope: string;
  key: string | null;
  include: KeepAliveKeyPattern;
  exclude: KeepAliveKeyPattern;
  max: number;
  onActivate?: (value: TValue, key: string, reused: boolean) => void;
  onDeactivate?: (value: TValue, key: string) => void;
  onCache?: (value: TValue, key: string) => void;
  onEvict?: (value: TValue, key: string) => void;
}

export type KeepAliveNodeHookSource = KeepAliveLifecycleHooks<readonly Node[]>;

export interface KeepAliveBlockSource<
  TBindings = unknown,
> extends KeepAliveHookSource {
  __lania_keepalive: 'block';
  payload: unknown;
  bindings?: readonly TBindings[];
}

export type KeepAliveBlockKind = 'contract';

export interface ResolvedKeepAliveBlock<TValue = unknown, TBindings = unknown> {
  payload: KeepAliveBlockSource<TBindings>;
  runtimeOptions: KeepAliveOptions<TValue>;
  runtimeSourceKind: KeepAliveBlockKind;
  bindings: readonly TBindings[];
}

export interface KeepAliveUncachedState<TInstance> {
  current: TInstance | null;
}

// HostState 负责管理节点缓存、hydration 节点以及最近一次可用的宿主目标。
export interface KeepAliveHostState {
  readNodes(): readonly Node[];
  ensureNodes(): Node[];
  syncNodes(nodes: readonly Node[]): void;
  hydrate(nodes: readonly Node[]): void;
  readHydratedNodes(): readonly Node[] | null;
  clearHydrated(): void;
  readCachedTarget(): KeepAliveHostTarget | null;
  writeCachedTarget(target: KeepAliveHostTarget | null): void;
  isMounted(): boolean;
  destroy(): void;
}

export interface KeepAliveMountedHostState {
  readNodes(): readonly Node[];
  syncNodes(nodes: readonly Node[]): void;
  readCachedTarget(): KeepAliveHostTarget | null;
  writeCachedTarget(target: KeepAliveHostTarget | null): void;
  clearCachedTarget(): void;
  isMounted(): boolean;
  markUnmounted(): void;
}

export interface KeepAliveHostTarget {
  parent: Node;
  // anchor 为 null 表示追加到 parent 末尾；非空时表示插入到该锚点之前。
  anchor: Node | null;
  owner?: DomHostOwner;
}

export interface KeepAliveTargetResolver {
  resolve(): KeepAliveHostTarget | null;
}

export interface KeepAliveHostRuntime {
  resolver: KeepAliveTargetResolver;
  host: KeepAliveHostCommitter;
  readHostTarget(): KeepAliveHostTarget | null;
}

export interface KeepAliveNodeRuntime extends KeepAliveHostRuntime {
  hostState: KeepAliveHostState;
}

// 工厂协议区分“直接产实例”与“带 key 包装成 entry”两类入口，便于 bucket 统一接管。
export interface KeepAliveSourceFactory<TValue> {
  createInstance(): KeepAliveInstance<TValue>;
  createEntry(key: string): KeepAliveInstanceEntry<KeepAliveInstance<TValue>>;
}

export interface KeepAliveNodeFactory<TValue> {
  createInstance(): KeepAliveQueuedInstance<TValue>;
  createEntry(
    key: string
  ): KeepAliveInstanceEntry<KeepAliveQueuedInstance<TValue>>;
}

export interface KeepAliveMountedFactory<
  TValue,
  TMounted extends KeepAliveSurface,
  TInstance extends KeepAliveInstance<TValue>,
> {
  createRecord(): {
    mounted: TMounted;
    instance: TInstance;
  };
  createInstance(): TInstance;
  createEntry(key: string): KeepAliveInstanceEntry<TInstance>;
}

export interface KeepAliveSurfaceDef<
  TValue,
  TMounted extends KeepAliveSurface,
  TInstance extends KeepAliveInstance<TValue> = KeepAliveInstance<TValue>,
> {
  readValue(): TValue;
  mounted: TMounted;
  initiallyActive?: boolean;
  extend?(instance: KeepAliveInstance<TValue>, mounted: TMounted): TInstance;
}

// RuntimeController 把 bucket 状态、宿主状态与 uncached 分支整合到同一控制面。
export interface KeepAliveRuntimeController<
  TEntry extends KeepAliveBucketEntry,
  TValue,
  TInstance,
> {
  hostRuntime: KeepAliveNodeRuntime;
  activeState: KeepAliveActiveState<TEntry, TValue>;
  uncachedController: KeepAliveUncached<TInstance>;
  readParent(): Node | null;
  createActivationRuntime(): KeepAliveActivation<TEntry, TValue> | null;
  readHostTarget(): KeepAliveHostTarget | null;
  readHydratedNodes(): readonly Node[] | null;
  clearHydrated(): void;
  hasActiveKeyChanged(key: string): boolean;
  replaceWithUncached(instance: TInstance): readonly Node[];
  clearUncached(): boolean;
  clearActive(): boolean;
  syncActive(
    bucket: KeepAliveBucket<TEntry>,
    key: string,
    callbacks?: KeepAliveCallbacks<TValue>
  ): void;
  destroy(): void;
}

export interface KeepAliveActivation<
  TEntry extends KeepAliveBucketEntry,
  TValue,
> {
  sync(options: {
    entry: TEntry;
    lifecycle: KeepAliveLifecycle<TEntry, TValue>;
    created: boolean;
    activeKeyChanged: boolean;
    updateEntry?(entry: TEntry): void;
  }): {
    didActivate: boolean;
  };
}

export const createTargetReader = (
  resolver: KeepAliveTargetResolver
): (() => KeepAliveHostTarget | null) => {
  return () => resolver.resolve();
};

export interface KeepAliveTargetOptions {
  fallbackTarget: KeepAliveHostTarget;
  redirectedTarget?: KeepAliveHostTarget | null;
  contextualTarget?: KeepAliveHostTarget | null;
}

// Committer 是 host 层的最小写接口，上层实例只依赖 commit/sync/clear 三个动作。
export interface KeepAliveHostCommitter {
  commit(nodes: readonly Node[]): void;
  sync(nodes: readonly Node[]): void;
  clear(): void;
}

export interface KeepAliveHostAdapter {
  mount(target: KeepAliveHostTarget, nodes: readonly Node[]): void;
  unmount(nodes: readonly Node[]): void;
}

export interface KeepAliveUncached<TInstance> {
  replace(nextInstance: TInstance): readonly Node[];
  clear(): boolean;
  readCurrent(): TInstance | null;
}

export interface KeepAliveBucketEntry {
  key: string;
}

export interface KeepAliveBucket<TEntry extends KeepAliveBucketEntry> {
  entries: Map<string, TEntry>;
  activeKey: string | null;
  callbacksByKey: Map<string, KeepAliveCallbacks<unknown>>;
  activeCallbacks?: KeepAliveCallbacks<unknown>;
}

// 缓存条目最终都要实现这一组最小实例能力。
export interface KeepAliveInstance<TValue = unknown> {
  readValue(): TValue;
  readNodes(): readonly Node[];
  isActive?(): boolean;
  isMounted?(): boolean;
  update?(): void;
  activate(): void;
  deactivate(): void;
  destroy(): void;
}

export type KeepAliveQueuedInstance<TValue = unknown> =
  KeepAliveInstance<TValue> & {
    queueNodes(nodes: readonly Node[]): void;
  };

export const isQueuedInstance = (
  value: unknown
): value is KeepAliveQueuedInstance => {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { queueNodes?: unknown }).queueNodes === 'function'
  );
};

export const queueInstanceNodes = (
  instance: KeepAliveInstance<unknown>,
  nodes: readonly Node[]
): boolean => {
  if (!isQueuedInstance(instance)) {
    return false;
  }
  instance.queueNodes(nodes);
  return true;
};

export const updateQueueableEntryNodes = (
  entry: { instance: KeepAliveInstance<unknown> },
  nodes: readonly Node[]
): void => {
  queueInstanceNodes(entry.instance, nodes);
  entry.instance.update?.();
};

export const readMappedEntryValue = <TValue, TResult>(
  entry: { instance: KeepAliveInstance<TValue> },
  mapValue: (value: TValue) => TResult
): TResult => {
  return mapValue(entry.instance.readValue());
};

export interface KeepAliveInstanceEntry<
  TInstance extends KeepAliveInstance<unknown>,
> extends KeepAliveBucketEntry {
  instance: TInstance;
}

export interface KeepAliveLifecycle<
  TEntry extends KeepAliveBucketEntry,
  TValue = unknown,
> {
  readValue(entry: TEntry): TValue;
  readNodes?(entry: TEntry): readonly Node[];
  isActive?(entry: TEntry): boolean;
  isMounted?(entry: TEntry): boolean;
  update?(entry: TEntry): void;
  activate?(entry: TEntry): void;
  deactivate?(entry: TEntry): void;
  evict?(entry: TEntry): void;
}

export interface KeepAliveSurface {
  readNodes(): readonly Node[];
  readHostTarget(): KeepAliveHostTarget | null;
  isMounted(): boolean;
  update(): void;
  activate(): void;
  detach(): void;
  destroy(): void;
}

export interface KeepAliveQueuedSurface extends KeepAliveSurface {
  queueNodes(nodes: readonly Node[]): void;
  // 把已排队节点真正刷入宿主，通常由 mounted.update 驱动。
  commitQueuedNodes(): void;
}

export interface KeepAliveRetainedSurfaceDef {
  initialNodes?: readonly Node[];
  readLiveNodes(): readonly Node[];
  readHostTarget(): KeepAliveHostTarget | null;
  update?(): void;
  activate?(): void;
  detach?(nodes: readonly Node[]): void;
  destroy?(): void;
}

export interface KeepAliveSourceDef<TSource, TValue> {
  source: TSource;
  readValue(source: TSource): TValue;
  readLiveNodes(source: TSource): readonly Node[];
  readHostTarget(): KeepAliveHostTarget | null;
  update?(source: TSource): void;
  activate?(source: TSource): void;
  deactivate?(source: TSource, previousNodes: readonly Node[]): void;
  destroy?(source: TSource): void;
  initiallyActive?: boolean;
}

export interface KeepAliveRetainedSource<TValue> {
  readValue(): TValue;
  initialNodes?: readonly Node[];
  readLiveNodes(): readonly Node[];
  readHostTarget(): KeepAliveHostTarget | null;
  update?(): void;
  activate?(): void;
  deactivate?(nodes: readonly Node[]): void;
  destroy?(): void;
  initiallyActive?: boolean;
}

export interface KeepAliveNodeDef<TValue> {
  initialNodes: readonly Node[];
  readValue(nodes: readonly Node[]): TValue;
  adapter: KeepAliveHostAdapter;
  resolvePreferredTarget(): KeepAliveHostTarget | null;
  inferTarget?(nodes: readonly Node[]): KeepAliveHostTarget | null;
  detach?(nodes: readonly Node[]): void;
  destroy?(): void;
  initiallyActive?: boolean;
}

export interface KeepAliveCallbacks<TValue> {
  onActivate?: (value: TValue, key: string, reused: boolean) => void;
  onDeactivate?: (value: TValue, key: string) => void;
  onCache?: (value: TValue, key: string) => void;
  onEvict?: (value: TValue, key: string) => void;
}

// ActiveState 记录“当前激活的是谁”以及该激活实例应复用的回调绑定。
export interface KeepAliveActiveState<
  TEntry extends KeepAliveBucketEntry,
  TValue = unknown,
> {
  bucket: KeepAliveBucket<TEntry> | null;
  key: string | null;
  onDeactivate?: (value: TValue, key: string) => void;
}

// 运行时选项中的钩子会被裁剪成统一 callbacks 结构，便于 bucket 复用。
export const resolveLifecycleCallbacks = <TValue>(
  options: KeepAliveOptions<TValue>
): KeepAliveCallbacks<TValue> => {
  return {
    onActivate: options.onActivate,
    onDeactivate: options.onDeactivate,
    onCache: options.onCache,
    onEvict: options.onEvict,
  };
};

export const detachKeepAliveNodes = (nodes: readonly Node[]): void => {
  nodes.forEach((node) => {
    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
  });
};

export const resolveMountedTarget = (
  nodes: readonly Node[]
): KeepAliveHostTarget | null => {
  // 只从仍在 DOM 中的节点反推 target，避免 detached 节点把缓存目标污染成无效位置。
  const mountedNodes = nodes.filter((node) => node.parentNode !== null);
  const parent = mountedNodes[0]?.parentNode;
  if (!parent) {
    return null;
  }

  return {
    parent,
    anchor: mountedNodes[mountedNodes.length - 1]?.nextSibling ?? null,
  };
};

// 默认 DOM adapter 通过 anchor 逆序插入节点，保持原有相对顺序。
// 倒序插入是为了在 `insertBefore` 语义下避免每次都重新计算“下一节点应该插在哪里”。
export const keepAliveDomHostAdapter: KeepAliveHostAdapter = {
  mount(target, nodes) {
    let beforeNode: Node | null = target.anchor;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index]!;
      if (
        node.parentNode !== target.parent ||
        node.nextSibling !== beforeNode
      ) {
        target.parent.insertBefore(node, beforeNode);
      }
      beforeNode = node;
    }
  },
  unmount(nodes) {
    detachKeepAliveNodes(nodes);
  },
};

export type KeepAliveCacheState<TEntry extends KeepAliveBucketEntry> =
  | {
      cacheable: false;
      previousActive: TEntry | null;
    }
  | {
      cacheable: true;
      key: string;
      previousActive: TEntry | null;
      entry: TEntry | null;
      reused: boolean;
    };

export type KeepAliveHitState<TEntry extends KeepAliveBucketEntry> = Extract<
  KeepAliveCacheState<TEntry>,
  { cacheable: true }
>;

export type KeepAliveMissState<TEntry extends KeepAliveBucketEntry> = Extract<
  KeepAliveCacheState<TEntry>,
  { cacheable: false }
>;
