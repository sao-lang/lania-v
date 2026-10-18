/**
 * 在模板 slot 层接入 KeepAlive 缓存能力。
 *
 * 它把模板 binding 实例包装成 keepalive entry，并在缓存命中、非缓存和 hydration 三种路径间切换。
 * 整体上可以把它看成“模板 slot 与 keepalive registry 的胶水层”：
 * 1. 负责把 template/bindings 翻译成 source factory；
 * 2. 负责在 write 时解析 payload、选择 cacheable 或 uncached 路径；
 * 3. 负责把 hydration 节点复用窗口限制在首次可消费的一次写入中。
 */
import {
  activateCacheEntry,
  clearNonCacheableState,
  createAnchoredRuntimeController,
  createLiveSourceFactory,
  dispatchKeepAliveUpdate,
  getKeepAliveBucket,
  keepAliveDomHostAdapter,
  resolveBlockPayload,
  resolveCacheState,
  resolveFreshHydratedNodes,
  resolveLifecycleCallbacks,
  sharedKeepAliveBuckets,
  sharedKeepAliveEntryLifecycle,
  type KeepAliveHostTarget,
  type KeepAliveInstance,
  type KeepAliveInstanceEntry,
  type KeepAliveCallbacks,
  type KeepAliveSourceDef,
  __resetSharedKeepAliveStateForTests,
} from '../../component/lifecycle/keepalive-registry';
import type { StaticTemplate } from '../../render/types';
import {
  getEmptyHydrationBoundaries,
  getEmptyHydrationSlots,
} from '../../render/dom';
import { acquireSlotNodeBuffer, releaseSlotNodeBuffer } from '../slot-pool';
import { removeNodes, type Slot } from './core';
import {
  readKeepAliveEntryNodes,
  type MountedBindingInstance,
  type TemplateBindingPayload,
} from './template/template-types';
import {
  mountHydratedBinding,
  mountTemplateBinding,
} from './template/template-factory';

type KeepAliveMountedInstance = KeepAliveInstance<readonly Node[]>;
type KeepAliveEntry = KeepAliveInstanceEntry<KeepAliveMountedInstance>;

// 把模板 binding 实例映射成 keepalive source 定义，供 live source factory 复用。
const createSlotSourceDef = (options: {
  template: StaticTemplate;
  bindings: readonly TemplateBindingPayload[];
  hydratedNodes: readonly Node[] | null;
  readHostTarget: () => KeepAliveHostTarget | null;
}): KeepAliveSourceDef<MountedBindingInstance, readonly Node[]> => {
  const { template, bindings, hydratedNodes, readHostTarget } = options;
  const source = createSlotBinding({
    template,
    bindings,
    hydratedNodes,
  });

  return {
    source,
    readValue: readKeepAliveEntryNodes,
    readLiveNodes: readKeepAliveEntryNodes,
    readHostTarget,
    update(bindingInstance: MountedBindingInstance) {
      bindingInstance.update();
    },
    activate(bindingInstance: MountedBindingInstance) {
      bindingInstance.activate();
    },
    deactivate(bindingInstance: MountedBindingInstance, previousNodes: readonly Node[]) {
      bindingInstance.deactivate();
      removeNodes(previousNodes);
    },
    destroy(bindingInstance: MountedBindingInstance) {
      bindingInstance.destroy();
    },
    initiallyActive: true,
  };
};

const createSlotSourceFactory = (options: {
  template: StaticTemplate;
  bindings: readonly TemplateBindingPayload[];
  hydratedNodes: readonly Node[] | null;
  readHostTarget: () => KeepAliveHostTarget | null;
}) => {
  // 每次 createDefinition 都重新生成 source，避免不同缓存实例共享同一 binding record。
  return createLiveSourceFactory<MountedBindingInstance, readonly Node[]>({
    createDefinition() {
      return createSlotSourceDef(options);
    },
  });
};

const keepAliveBuckets = sharedKeepAliveBuckets;

export const __resetKeepAliveSlotStateForTests = (): void => {
  __resetSharedKeepAliveStateForTests();
};

const keepAliveEntryLifecycle = sharedKeepAliveEntryLifecycle;

// hydration 命中时优先尝试复用现有 DOM，失败后退回纯保留节点实例。
const createSlotBinding = (options: {
  template: StaticTemplate;
  bindings: readonly TemplateBindingPayload[];
  hydratedNodes: readonly Node[] | null;
}): MountedBindingInstance => {
  const { template, bindings, hydratedNodes } = options;

  if (!hydratedNodes) {
    return mountTemplateBinding(template, bindings);
  }

  if (bindings.length !== 1) {
    return createHydratedBinding(hydratedNodes);
  }

  try {
    return mountHydratedBinding(hydratedNodes, template, bindings);
  } catch {
    return createHydratedBinding(hydratedNodes);
  }
};

// 纯 hydrated binding 只保留节点集合，不再补建模板 slot。
const createHydratedBinding = (
  nodes: readonly Node[]
): MountedBindingInstance => {
  const retainedNodes = [...nodes];

  return {
    nodes: retainedNodes,
    mounted: {
      nodes: retainedNodes,
      hydrated: true,
      hydrationSlots: getEmptyHydrationSlots(),
      hydrationBoundaries: getEmptyHydrationBoundaries(),
    },
    slots: [],
    update() {},
    activate() {},
    deactivate() {},
    destroy() {
      removeNodes(retainedNodes);
    },
  };
};

export class KeepAliveSlot implements Slot<unknown> {
  readonly type = 'keepalive';
  readonly frequency = 'normal';
  private readonly runtime = createAnchoredRuntimeController<
    KeepAliveEntry,
    readonly Node[],
    KeepAliveMountedInstance
  >({
    anchor: this.node,
    acquireNodes: acquireSlotNodeBuffer,
    releaseNodes: releaseSlotNodeBuffer,
    lifecycle: keepAliveEntryLifecycle,
    destroyInstance(current) {
      current.destroy();
    },
    readInstanceNodes(current) {
      return current.readNodes();
    },
    adapter: keepAliveDomHostAdapter,
  });

  constructor(
    public readonly node: Comment,
    private readonly template: StaticTemplate,
    public readonly index: number
  ) {}

  // hydrate 只登记候选节点，真正是否复用仍由后续 write 时的 payload/bindings 形态决定。
  hydrate(nodes: readonly Node[]): void {
    this.runtime.hostRuntime.hostState.hydrate(nodes);
  }

  // 每次写入都会先解析 block payload，再在 cacheable 与 uncached 两条路径之间分流。
  write(value: unknown): void {
    const activationRuntime = this.runtime.createActivationRuntime();
    if (!activationRuntime) {
      return;
    }

    const resolvedPayload = resolveBlockPayload<
      readonly Node[],
      TemplateBindingPayload
    >(value);
    if (!resolvedPayload) {
      // Fallback: behave like an IfSlot with always-truthy content.
      return;
    }

    const { runtimeOptions, bindings } = resolvedPayload;
    const { scope, key, include, exclude, max } = runtimeOptions;
    const bucket = getKeepAliveBucket(keepAliveBuckets, scope);
    const callbacks: KeepAliveCallbacks<readonly Node[]> =
      resolveLifecycleCallbacks(runtimeOptions);

    const cacheState = resolveCacheState(bucket, key, include, exclude);

    // 不可缓存时直接替换当前实例，并清理 bucket 中的非缓存状态。
    if (!cacheState.cacheable) {
      this.runtime.clearActive();
      clearNonCacheableState({
        bucket,
        cacheState,
        lifecycle: keepAliveEntryLifecycle,
        callbacks,
      });
      const instance = createSlotSourceFactory({
        template: this.template,
        bindings,
        hydratedNodes: null,
        readHostTarget: () => this.runtime.readHostTarget(),
      }).createInstance();
      this.runtime.replaceWithUncached(instance);
      return;
    }

    this.runtime.clearUncached();
    const activeKey = cacheState.key;
    const hydratedNodes = resolveFreshHydratedNodes({
      cacheState,
      hydratedNodes: this.runtime.readHydratedNodes(),
      activeState: this.runtime.activeState,
    });
    // 可缓存时尝试命中或创建条目，必要时结合 hydration 节点冷启动。
    const { created } = activateCacheEntry({
      bucket,
      cacheState,
      max,
      lifecycle: keepAliveEntryLifecycle,
      activeKeyChanged: this.runtime.hasActiveKeyChanged(activeKey),
      runtime: activationRuntime,
      updateEntry: (entry) => {
        dispatchKeepAliveUpdate(entry, keepAliveEntryLifecycle);
      },
      callbacks,
      createEntry: () =>
        createSlotSourceFactory({
          template: this.template,
          bindings,
          hydratedNodes,
          readHostTarget: () => this.runtime.readHostTarget(),
        }).createEntry(activeKey),
    });
    if (created) {
      this.runtime.clearHydrated();
    }
    this.runtime.syncActive(bucket, activeKey, callbacks);
  }

  destroy(): void {
    // active entry 若仍存在于当前 slot，先主动销毁实例，再清空 host/runtime 自身记录。
    const activeEntry =
      this.runtime.activeState.bucket && this.runtime.activeState.key
        ? this.runtime.activeState.bucket.entries.get(this.runtime.activeState.key) ?? null
        : null;
    activeEntry?.instance.destroy();
    this.runtime.clearActive();
    removeNodes(this.runtime.hostRuntime.hostState.readNodes());
    this.runtime.destroy();
  }
}
