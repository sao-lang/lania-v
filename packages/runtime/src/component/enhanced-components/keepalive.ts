/**
 * 增强 `KeepAlive` 组件的 renderable 适配层。
 *
 * 该文件把通用 keep-alive 注册表能力桥接到 `EnhancedRenderable`：
 * - 为一组可渲染节点创建可缓存的实例工厂；
 * - 按 scope 复用运行时控制器，维护当前激活项与宿主节点同步；
 * - 根据 payload / props 解析缓存策略，并在可缓存与不可缓存路径之间切换。
 */
import {
  activateCacheEntry,
  clearNonCacheableState,
  createContextualFactory,
  createContextualRuntimeController,
  detachKeepAliveNodes,
  getKeepAliveBucket,
  resolveMountedTarget,
  __resetSharedKeepAliveStateForTests,
  readMappedEntryValue,
  resolveCacheState,
  resolveLifecycleCallbacks,
  resolveOptionsFromPayload,
  resolveOptionsWithScope,
  sharedKeepAliveBuckets,
  sharedKeepAliveEntryLifecycle,
  type KeepAliveInstance,
  type KeepAliveInstanceEntry,
  type KeepAliveNodeFactory,
  updateQueueableEntryNodes,
} from '../lifecycle/keepalive-registry';
import { defineEnhancedComponent } from './utils/factory';
import {
  asRenderable,
  collectRenderableNodes,
  createValueFromNodes,
  invokeRenderable,
} from './utils/renderable';
import type { EnhancedRenderable, KeepAliveProps } from './types';

type RenderableKeepAliveInstance = KeepAliveInstance<EnhancedRenderable>;
type RenderableKeepAliveEntry = KeepAliveInstanceEntry<RenderableKeepAliveInstance>;

const renderableRuntimeControllers = new Map<
  string,
  ReturnType<
    typeof createContextualRuntimeController<
      RenderableKeepAliveEntry,
      EnhancedRenderable,
      RenderableKeepAliveInstance
    >
  >
>();

const createRenderableFactory = (
  initialNodes: readonly Node[]
): KeepAliveNodeFactory<EnhancedRenderable> => {
  return createContextualFactory<EnhancedRenderable>({
    initialNodes,
    readValue(nodes) {
      return createValueFromNodes(nodes);
    },
    detach(nodes) {
      // KeepAlive 只脱离当前 DOM，不销毁节点，后续命中缓存时还能重新挂回。
      detachKeepAliveNodes(nodes);
    },
    destroy() {},
    initiallyActive: true,
  });
};

export const __resetKeepAliveRenderableStateForTests = (): void => {
  renderableRuntimeControllers.forEach((controller) => {
    controller.destroy();
  });
  renderableRuntimeControllers.clear();
  __resetSharedKeepAliveStateForTests();
};

const keepAliveBuckets = sharedKeepAliveBuckets;
const keepAliveEntryLifecycle = sharedKeepAliveEntryLifecycle;

const getRenderableRuntimeController = (scope: string) => {
  const existing = renderableRuntimeControllers.get(scope);
  if (existing) {
    return existing;
  }

  // 同一 scope 共享一套激活态控制器，保证多次渲染时目标容器和活跃 key 一致。
  const created = createContextualRuntimeController<
    RenderableKeepAliveEntry,
    EnhancedRenderable,
    RenderableKeepAliveInstance
  >({
    lifecycle: keepAliveEntryLifecycle,
    destroyInstance(current) {
      current.destroy();
    },
    readInstanceNodes(current) {
      return current.readNodes();
    },
    inferTarget(nodes) {
      return resolveMountedTarget(nodes);
    },
  });
  renderableRuntimeControllers.set(scope, created);
  return created;
};

const resolveChildren = (children: unknown): EnhancedRenderable => {
  return invokeRenderable(asRenderable(children));
};

const updateEntry = (
  entry: { instance: KeepAliveInstance<EnhancedRenderable> },
  nextValue: EnhancedRenderable
): void => {
  updateQueueableEntryNodes(entry, collectRenderableNodes(nextValue));
};

const readEntry = (entry: {
  instance: KeepAliveInstance<EnhancedRenderable>;
}): EnhancedRenderable => {
  return readMappedEntryValue(entry, (value) => value);
};

export const KeepAlive = defineEnhancedComponent(
  'KeepAlive',
  (props: KeepAliveProps): EnhancedRenderable => {
    const runtimeOptions = props.payload
      ? resolveOptionsFromPayload<EnhancedRenderable>({
          payload: props.payload,
          defaultScope: 'component:default',
        }).runtimeOptions
      : resolveOptionsWithScope<EnhancedRenderable>('component:default', {
          scope: props.scope,
          key: props.cacheKey,
          include: props.include,
          exclude: props.exclude,
          max: props.max,
          onActivate: props.onActivate,
          onDeactivate: props.onDeactivate,
          onCache: props.onCache,
          onEvict: props.onEvict,
        });
    const { scope, key, include, exclude, max } = runtimeOptions;
    const callbacks = resolveLifecycleCallbacks(runtimeOptions);
    const bucket = getKeepAliveBucket(keepAliveBuckets, scope);
    const runtime = getRenderableRuntimeController(scope);
    const cacheState = resolveCacheState(bucket, key, include, exclude);

    if (!cacheState.cacheable) {
      // 当前 key 被 include / exclude 规则排除时，直接走普通渲染并清理活跃态残留。
      runtime.clearActive();
      clearNonCacheableState({
        bucket,
        cacheState,
        lifecycle: keepAliveEntryLifecycle,
        callbacks,
      });
      return resolveChildren(props.children);
    }

    const activeKey = cacheState.key;
    const initialValue = resolveChildren(props.children);
    const renderableFactory = cacheState.entry
      ? null
      // 首次写入缓存时，基于当前渲染结果快照创建 entry 工厂。
      : createRenderableFactory(collectRenderableNodes(initialValue));
    const { entry } = activateCacheEntry({
      bucket,
      cacheState,
      max,
      lifecycle: keepAliveEntryLifecycle,
      callbacks,
      activeKeyChanged: runtime.hasActiveKeyChanged(activeKey),
      runtime: runtime.createActivationRuntime() ?? undefined,
      updateEntry: (currentEntry) => {
        // 命中缓存但子树发生变化时，只更新 entry 持有的节点集合，不重建缓存记录。
        updateEntry(
          currentEntry,
          resolveChildren(props.children)
        );
      },
      createEntry: renderableFactory
        ? () => renderableFactory.createEntry(activeKey)
        : undefined,
    });
    // 把 entry 当前节点同步回宿主运行时，再更新该 scope 的活跃 key。
    runtime.hostRuntime.hostState.syncNodes(entry.instance.readNodes());
    runtime.syncActive(bucket, activeKey, callbacks);
    return readEntry(entry);
  }
);
