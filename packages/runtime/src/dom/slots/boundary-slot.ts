/**
 * 动态边界类 slot 实现。
 *
 * 该文件集中处理三类“需要自己维护一段节点区间”的 slot：
 * - `BoundarySlot`：承接 Suspense / LazyLoad / ErrorBoundary 的运行时切换；
 * - `IfSlot`：在 truthy / falsy 两个分支之间切换模板实例；
 * - `TeleportSlot`：把模板实例挂载到外部目标容器，同时保留当前位置锚点。
 *
 * 这里最复杂的部分是 hydration 与后续重放：
 * - hydration 阶段要尽量复用 SSR 已输出的节点和 boundary marker；
 * - 首次写入后再逐步把控制权交给运行时实例，避免 SSR/CSR 对同一段 DOM 重复管理；
 * - 当上层 boundary 或 teleport 目标变化时，需要在不丢失节点所有权的前提下重放区间。
 *
 * 可以把它理解成“模板 slot 层面的区间控制器”，重点不在渲染什么，而在谁拥有这段节点区间。
 *
 * 阅读顺序建议：
 * - 先看 `BoundarySlot`，理解 boundary host 如何驱动 child/fallback 切换；
 * - 再看 `IfSlot`，理解普通条件分支如何维护一对锚点之间的 DOM；
 * - 最后看 `TeleportSlot`，理解“当前位置保留逻辑锚点、真实节点迁移到目标容器”的所有权模型。
 */
import {
  createBoundaryHost,
  createErrorBoundaryHost,
  createLazyBoundaryHost,
  createSuspenseBoundaryHost,
} from '../../component/lifecycle/boundary-host';
import {
  executeErrorBoundary,
  executeLazyBoundary,
  executeSuspenseBoundary,
  readBoundaryComponent,
} from '../../component/lifecycle/boundary-registry';
import { acquireSlotNodeBuffer, releaseSlotNodeBuffer } from '../slot-pool';
import { appendNodesBeforeAnchor, removeNodes, type Slot } from './core';
import {
  attachNestedReplay,
  canReplayBoundarySlotRange,
  createBoundarySlotRangeHost,
  ensureRangeAnchors,
  hydrateSlotRange,
  readRangeContentNodes,
  readMountedNodes,
  replayBoundarySlotHost,
  renderBoundarySlotRange,
  type BoundaryBlockPayload,
  type BoundarySlotRangeHost,
  type IfBlockPayload,
  type MountedBindingInstance,
  type TemplateBindingPayload,
} from './template/template-types';
import type { HydrationBoundaryRecord, StaticTemplate } from '../../render/types';
import { parseBoundaryMarker } from '../../render/markers';
import {
  mountHydratedBinding,
  mountTemplateBinding,
} from './template/template-factory';

type HydratedBoundaryState = {
  record: HydrationBoundaryRecord;
  branch: 'child' | 'fallback';
};

const readBoundaryBlock = (value: unknown): BoundaryBlockPayload | null => {
  return value &&
    typeof value === 'object' &&
    (value as { __lania_boundary?: unknown }).__lania_boundary === 'block'
    ? (value as BoundaryBlockPayload)
    : null;
};

const readBoundaryPayloadIndex = (payload: unknown): number | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const boundaryIndex = (payload as { boundaryIndex?: unknown }).boundaryIndex;
  return typeof boundaryIndex === 'number' ? boundaryIndex : null;
};

const readBoundaryStatus = (record: HydrationBoundaryRecord): string | null => {
  const metadata = record.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const status = (metadata as Record<string, unknown>).status;
  return typeof status === 'string' ? status : null;
};

const resolveHydratedBoundaryBranch = (
  record: HydrationBoundaryRecord
): 'child' | 'fallback' => {
  // SSR 注释 marker 中的状态决定 hydration 首次接管时默认站在哪个分支上。
  const status = readBoundaryStatus(record);
  if (record.component === 'Suspense') {
    return status === 'pending' || status === 'rejected' ? 'fallback' : 'child';
  }

  if (record.component === 'LazyLoad') {
    return record.payload?.initialState === 'inactive' ? 'fallback' : 'child';
  }

  if (record.component === 'ErrorBoundary') {
    return status === 'rejected' || record.payload?.initialState === 'rejected'
      ? 'fallback'
      : 'child';
  }

  return 'child';
};

const isThenable = (value: unknown): value is PromiseLike<unknown> => {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
};

const collectTopLevelHydrationBoundaries = (
  nodes: readonly Node[]
): HydrationBoundaryRecord[] => {
  // 只提取当前节点列表顶层可闭合的 boundary，避免把嵌套 boundary 误判成当前 slot 自己的内容。
  const stack = new Map<string, Array<{ comment: Comment; index: number }>>();
  const records: HydrationBoundaryRecord[] = [];

  nodes.forEach((node, index) => {
    if (node.nodeType !== Node.COMMENT_NODE) {
      return;
    }

    const comment = node as Comment;
    const marker = parseBoundaryMarker(comment.data);
    if (!marker) {
      return;
    }

    if (marker.position === 'start') {
      const entries = stack.get(marker.id) ?? [];
      entries.push({ comment, index });
      stack.set(marker.id, entries);
      return;
    }

    const starts = stack.get(marker.id);
    const start = starts?.pop();
    if (!start) {
      return;
    }

    if (starts && starts.length === 0) {
      stack.delete(marker.id);
    }

    records.push({
      id: marker.id,
      component: marker.component,
      start: start.comment,
      end: comment,
      contentNodes: nodes.slice(start.index + 1, index),
      payload: marker.payload,
      metadata: marker.metadata,
    });
  });

  return records;
};

export class BoundarySlot implements Slot<unknown> {
  readonly type = 'boundary';
  readonly frequency = 'normal';
  private currentNodes: Node[] | null = acquireSlotNodeBuffer();
  private childInstance: MountedBindingInstance | null = null;
  private fallbackInstance: MountedBindingInstance | null = null;
  private lastValue: BoundaryBlockPayload | null = null;
  private activeBranch: 'child' | 'fallback' | null = null;
  private hydratedBoundary: HydratedBoundaryState | null = null;
  private readonly host = createBoundarySlotRangeHost();
  private readonly boundaryHost = createBoundaryHost({
    requestUpdate: () => {
      this.replayCurrentBoundary();
    },
  });

  constructor(
    public readonly node: Comment,
    private readonly childTemplate: StaticTemplate,
    public readonly index: number,
    private readonly fallbackTemplate?: StaticTemplate
  ) {}

  hydrate(nodes: readonly Node[], value?: unknown): void {
    // 先接管 SSR 已存在的节点区间，再根据 payload 推断当前应复用哪一个 hydrated boundary。
    hydrateSlotRange(this.host, this.node, this.ensureCurrentNodes(), nodes);
    const block = readBoundaryBlock(value);
    this.hydratedBoundary = this.resolveHydratedBoundary(nodes, block);
    this.lastValue = block
      ? {
          ...block,
          payload: this.hydratedBoundary?.record.payload ?? block.payload,
        }
      : this.lastValue;
  }

  write(value: unknown): void {
    const block = readBoundaryBlock(value);

    if (!block) {
      this.renderNodes([]);
      this.lastValue = null;
      this.hydratedBoundary = null;
      return;
    }

    this.lastValue = block;
    const component = readBoundaryComponent(block.payload);

    // boundary 的真正行为由 payload 中登记的组件类型决定，这里只做分发。
    if (component === 'LazyLoad') {
      this.writeLazyLoad(block);
      return;
    }

    if (component === 'ErrorBoundary') {
      this.writeErrorBoundary(block);
      return;
    }

    if (component === 'Suspense') {
      this.writeSuspense(block);
      return;
    }

    this.renderChild(block.bindings ?? []);
  }

  destroy(): void {
    this.childInstance?.destroy();
    this.childInstance = null;
    this.fallbackInstance?.destroy();
    this.fallbackInstance = null;
    if (this.currentNodes) {
      removeNodes(this.currentNodes);
      releaseSlotNodeBuffer(this.currentNodes);
      this.currentNodes = null;
    }
  }

  private ensureCurrentNodes(): Node[] {
    if (!this.currentNodes) {
      this.currentNodes = acquireSlotNodeBuffer();
    }
    return this.currentNodes;
  }

  private renderNodes(nodes: readonly Node[]): void {
    renderBoundarySlotRange(this.host, this.node, this.ensureCurrentNodes(), nodes);
  }

  private mountWithHydrationFallback(
    template: StaticTemplate,
    bindings: readonly TemplateBindingPayload[],
    hydratedNodes: readonly Node[]
  ): MountedBindingInstance {
    if (hydratedNodes.length === 0) {
      return mountTemplateBinding(template, bindings);
    }

    try {
      return mountHydratedBinding(hydratedNodes, template, bindings);
    } catch (error) {
      if (isThenable(error)) {
        throw error;
      }

      return mountTemplateBinding(template, bindings);
    }
  }

  private ensureChildInstance(bindings: readonly TemplateBindingPayload[]): MountedBindingInstance {
    if (!this.childInstance) {
      const hydratedNodes = this.readHydratedNodes('child');
      // child/fallback 首次实例化时尽量消费 SSR 节点；一旦 activeBranch 确立，就不再重复读取 hydrated 内容。
      this.childInstance = this.mountWithHydrationFallback(
        this.childTemplate,
        bindings,
        hydratedNodes
      );
      if (this.activeBranch === null) {
        this.hydratedBoundary = null;
      }
    } else {
      this.childInstance.update();
    }
    attachNestedReplay(
      this.host,
      this.childInstance,
      () => this.lastValue,
      () => {
        this.write(this.lastValue);
      }
    );
    return this.childInstance;
  }

  private ensureFallbackInstance(): MountedBindingInstance | null {
    if (!this.fallbackTemplate) {
      // 某些 boundary 没有显式 fallback，这里允许直接返回 null，让上层渲染空区间。
      return null;
    }

    if (!this.fallbackInstance) {
      const hydratedNodes = this.readHydratedNodes('fallback');
      this.fallbackInstance = this.mountWithHydrationFallback(
        this.fallbackTemplate,
        [],
        hydratedNodes
      );
      if (this.activeBranch === null) {
        this.hydratedBoundary = null;
      }
    }

    attachNestedReplay(
      this.host,
      this.fallbackInstance,
      () => this.lastValue,
      () => {
        this.write(this.lastValue);
      }
    );
    return this.fallbackInstance;
  }

  setParentBoundaryReplay(replay: (() => void) | null): void {
    this.host.parentBoundaryReplay = replay;
  }

  private readHydratedNodes(branch: 'child' | 'fallback'): Node[] {
    // 只有在首次接管 SSR DOM、且尚未明确 activeBranch 时，才允许消费 hydrated 节点。
    if (this.activeBranch !== null) {
      return [];
    }

    if (!this.hydratedBoundary) {
      return readRangeContentNodes(this.host, this.ensureCurrentNodes()).slice();
    }

    if (this.hydratedBoundary.branch !== branch) {
      return [];
    }

    return this.hydratedBoundary.record.contentNodes.slice();
  }

  private resolveHydratedBoundary(
    nodes: readonly Node[],
    block: BoundaryBlockPayload | null
  ): HydratedBoundaryState | null {
    // 先按组件类型缩小匹配范围，再尽量利用 boundaryIndex 对齐到编译期写入的目标 boundary。
    // 这里的匹配策略是“能精确则精确，不能精确时保守回退到首个候选”，
    // 目的是在 SSR 标记不完整或编译产物版本轻微漂移时，仍尽量接管现有 DOM。
    const records = collectTopLevelHydrationBoundaries(nodes);
    if (records.length === 0) {
      return null;
    }

    const component = readBoundaryComponent(block?.payload) ?? undefined;
    const matchingRecords = component
      ? records.filter((record) => record.component === component)
      : records;
    const candidates = matchingRecords.length > 0 ? matchingRecords : records;

    const expectedBoundaryIndex = readBoundaryPayloadIndex(block?.payload);
    const record =
      expectedBoundaryIndex === null
        ? candidates[0] ?? null
        : candidates.find((candidate) => candidate.payload?.boundaryIndex === expectedBoundaryIndex) ??
          candidates[0] ??
          null;

    return record
      ? {
          record,
          branch: resolveHydratedBoundaryBranch(record),
        }
      : null;
  }

  private renderChild(bindings: readonly TemplateBindingPayload[]): void {
    const instance = this.ensureChildInstance(bindings);
    // 当前激活分支只暴露自身节点给 range host，未激活分支实例可留在内存中等待复用。
    // 这意味着 boundary 的“切换”本质上是替换当前暴露节点，而不是每次都重建另一侧实例。
    this.renderNodes(readMountedNodes(instance));
    this.activeBranch = 'child';
  }

  private renderFallback(): void {
    const instance = this.ensureFallbackInstance();
    // fallback 与 child 共用同一段 range host，只是当前暴露的 nodes 来源不同。
    // 因此 fallback 不需要单独维护另一套宿主区间，切换成本主要落在实例复用策略上。
    this.renderNodes(instance ? readMountedNodes(instance) : []);
    this.activeBranch = 'fallback';
  }

  private renderLazyFallback(sentinel: HTMLSpanElement): void {
    // LazyLoad 的 fallback 需要把 sentinel 一并插入，供可见性/激活逻辑后续继续观察。
    const instance = this.ensureFallbackInstance();
    this.renderNodes(instance ? [sentinel, ...readMountedNodes(instance)] : [sentinel]);
    this.activeBranch = 'fallback';
  }

  private replayCurrentBoundary(): void {
    // 子边界请求重放时，复用 range host 重新执行当前 boundary 的写入逻辑。
    replayBoundarySlotHost(this.host, this.lastValue, () => {
      this.write(this.lastValue);
    });
  }

  private writeLazyLoad(block: BoundaryBlockPayload): void {
    // LazyLoad 由 host 决定当前展示 child 还是带 sentinel 的 fallback。
    // slot 只负责把 child/fallback 的具体渲染动作注入给 host，
    // 触发时机由可见性与 preload 状态机统一控制。
    executeLazyBoundary({
      payload: block.payload,
      host: createLazyBoundaryHost({
        boundary: this.boundaryHost,
        renderChild: () => {
          this.renderChild(block.bindings ?? []);
        },
        renderFallback: (sentinel) => {
          this.renderLazyFallback(sentinel);
        },
      }),
    });
  }

  private writeErrorBoundary(block: BoundaryBlockPayload): void {
    // 发生错误时销毁 child 实例，避免后续 fallback 与旧 child 节点共存。
    // 这里故意不保留错误前的 child instance，因为 ErrorBoundary 语义要求失败子树彻底退出当前分支。
    executeErrorBoundary({
      payload: block.payload,
      host: createErrorBoundaryHost({
        boundary: this.boundaryHost,
        renderChild: () => {
          this.renderChild(block.bindings ?? []);
        },
        renderFallback: (_error) => {
          this.childInstance?.destroy();
          this.childInstance = null;
          this.renderFallback();
        },
      }),
    });
  }

  private writeSuspense(block: BoundaryBlockPayload): void {
    // Suspense 与 Lazy/Error 共用 boundary host，但 fallback 触发条件来自 Promise 生命周期。
    // 非 Promise 异常继续上抛，避免把真正的运行时错误误判成“可等待资源”。
    executeSuspenseBoundary({
      payload: block.payload,
      host: createSuspenseBoundaryHost({
        boundary: this.boundaryHost,
        renderChild: () => {
          this.renderChild(block.bindings ?? []);
        },
        renderFallback: () => {
          this.renderFallback();
        },
        onNonPromiseError: (error) => {
          throw error;
        },
      }),
    });
  }
}

export class IfSlot implements Slot<boolean> {
  readonly type = 'if';
  readonly frequency = 'normal';
  private currentNodes: Node[] | null = acquireSlotNodeBuffer();
  private startAnchor: Comment | null = null;
  private activeBranch: 'truthy' | 'falsy' | null = null;
  private truthyInstance: MountedBindingInstance | null = null;
  private falsyInstance: MountedBindingInstance | null = null;

  constructor(
    public readonly node: Comment,
    private readonly truthyTemplate: StaticTemplate,
    public readonly index: number,
    private readonly falsyTemplate?: StaticTemplate
  ) {}

  private resolveLegacyInstance(
    templateOrFactory: StaticTemplate | (() => Node | Node[] | DocumentFragment),
    branchBindings: readonly TemplateBindingPayload[]
  ): MountedBindingInstance | null {
    // 兼容旧路径：分支模板既可能是静态模板，也可能是直接返回节点的工厂函数。
    if (
      typeof templateOrFactory === 'object' &&
      templateOrFactory !== null &&
      'clone' in templateOrFactory
    ) {
      return mountTemplateBinding(
        templateOrFactory as StaticTemplate,
        branchBindings
      );
    }

    const rendered = (templateOrFactory as () => Node | Node[] | DocumentFragment)();
    const nodes =
      rendered instanceof DocumentFragment
        ? [...rendered.childNodes]
        : Array.isArray(rendered)
          ? rendered
          : [rendered];
    // 旧工厂路径没有真正的 mounted 模板元数据，只暴露一份最小生命周期壳层。
    return {
      fragment: document.createDocumentFragment(),
      nodes,
      mounted: {
        nodes,
        hydrated: false,
        hydrationSlots: new Map(),
        hydrationBoundaries: [],
      },
      slots: [],
      update() {},
      activate() {},
      deactivate() {},
      destroy() {},
    };
  }

  private ensureCurrentNodes(): Node[] {
    this.currentNodes ??= acquireSlotNodeBuffer();
    return this.currentNodes;
  }

  private ensureStartAnchor(parent: Node): void {
    // `IfSlot` 额外维护一个起始锚点，用来稳定记录“当前分支实际占据的 DOM 区间”。
    if (this.startAnchor && this.startAnchor.parentNode === parent) {
      if (this.startAnchor.nextSibling !== this.node) {
        const currentNodes = this.currentNodes;
        const firstNode =
          currentNodes && currentNodes.length > 0 ? currentNodes[0] : null;
        const reference =
          firstNode && firstNode.parentNode === parent ? firstNode : this.node;
        parent.insertBefore(this.startAnchor, reference);
      }
      return;
    }

    this.startAnchor ??= document.createComment('');
    const currentNodes = this.currentNodes;
    const firstNode = currentNodes && currentNodes.length > 0 ? currentNodes[0] : null;
    const reference = firstNode && firstNode.parentNode === parent ? firstNode : this.node;
    parent.insertBefore(this.startAnchor, reference);
  }

  private syncCurrentNodesFromDom(): void {
    const parent = this.node.parentNode;
    const start = this.startAnchor;
    if (!parent || !start) {
      return;
    }

    const nodes = this.ensureCurrentNodes();
    nodes.length = 0;
    let cursor: ChildNode | null = start.nextSibling;
    while (cursor && cursor !== this.node) {
      // 始终以 startAnchor 和 slot 注释锚点之间的真实 DOM 为准，避免内部缓存漂移。
      nodes.push(cursor as Node);
      cursor = cursor.nextSibling;
    }
  }

  hydrate(nodes: readonly Node[], value: boolean): void {
    this.ensureCurrentNodes().push(...nodes);
    if (this.node.parentNode) {
      this.ensureStartAnchor(this.node.parentNode);
    }
    // hydration 期间优先相信“SSR 当前已经挂在页面上的 DOM 事实”。
    // 对没有 fallback 的 `<When>`，直接根据节点是否存在来推断分支，避免首帧 runtime 值暂时滞后导致误删。
    const activeBranch: 'truthy' | 'falsy' =
      !this.falsyTemplate ? (nodes.length > 0 ? 'truthy' : 'falsy') : value ? 'truthy' : 'falsy';
    this.activeBranch = activeBranch;

    // 先把 hydrated 节点登记进当前分支实例，后续 write 才能继续接管并正确移除这批 SSR 节点。
    // 否则第一次 update 可能会新建模板实例并覆盖 currentNodes，留下仍无人管理的旧 SSR 节点。
    if (nodes.length > 0) {
      const hydratedNodes = [...nodes];
      this.setInstance(activeBranch, {
        fragment: document.createDocumentFragment(),
        nodes: hydratedNodes,
        mounted: {
          nodes: hydratedNodes,
          hydrated: true,
          hydrationSlots: new Map(),
          hydrationBoundaries: [],
        },
        slots: [],
        update() {},
        activate() {},
        deactivate() {},
        destroy() {},
      });
    }
  }

  private getInstance(branch: 'truthy' | 'falsy'): MountedBindingInstance | null {
    // 两个分支实例分开缓存，便于 `retain` 模式下切回时直接复用。
    return branch === 'truthy' ? this.truthyInstance : this.falsyInstance;
  }

  private setInstance(branch: 'truthy' | 'falsy', instance: MountedBindingInstance | null): void {
    if (branch === 'truthy') {
      this.truthyInstance = instance;
      return;
    }

    this.falsyInstance = instance;
  }

  private destroyBranch(branch: 'truthy' | 'falsy'): void {
    const instance = this.getInstance(branch);
    // `remount` 模式下旧分支会被彻底销毁；`retain` 模式则由调用方决定是否只 deactivate。
    instance?.destroy();
    this.setInstance(branch, null);
  }

  write(value: boolean): void {
    const parent = this.node.parentNode;

    if (!parent) {
      return;
    }

    this.ensureStartAnchor(parent);

    const isBlockPayload =
      typeof value === 'object' &&
      value !== null &&
      (value as IfBlockPayload).__lania_if === 'block';
    const payload = isBlockPayload ? (value as IfBlockPayload) : null;
    const nextValue = payload ? Boolean(payload.when) : Boolean(value);
    const nextBranch: 'truthy' | 'falsy' = nextValue ? 'truthy' : 'falsy';
    const mode = payload?.mode ?? 'remount';
    const truthyBindings = payload ? (payload.truthyBindings ?? []) : [];
    const falsyBindings = payload ? (payload.falsyBindings ?? []) : [];

    // 两侧分支在切换前都先 update，一方面刷新 retained 节点内容，另一方面让复用分支带着最新数据进入激活。
    if (this.truthyInstance) {
      this.truthyInstance.update();
    }
    if (this.falsyInstance) {
      this.falsyInstance.update();
    }

    let instance = this.getInstance(nextBranch);
    if (!instance) {
      const template = nextBranch === 'truthy' ? this.truthyTemplate : this.falsyTemplate;
      const branchBindings = nextBranch === 'truthy' ? truthyBindings : falsyBindings;
      instance = template
        ? this.resolveLegacyInstance(
            template as StaticTemplate | (() => Node | Node[] | DocumentFragment),
            branchBindings
          )
        : null;
      this.setInstance(nextBranch, instance);
    } else {
      instance.update();
    }

    if (this.activeBranch !== nextBranch && this.currentNodes) {
      // 分支切换时先同步当前 DOM，再决定是销毁旧分支还是仅 deactivate 以支持复用。
      this.syncCurrentNodesFromDom();
      if (this.activeBranch) {
        if (mode === 'remount') {
          this.destroyBranch(this.activeBranch);
        } else {
          this.getInstance(this.activeBranch)?.deactivate();
        }
      }
      removeNodes(this.currentNodes);
      this.currentNodes.length = 0;
    }

    // 没有 fallback 模板时，即便 hydration 状态与 runtime 分支一度错位，也要兜底清掉残留 truthy 节点。
    if (nextBranch === 'falsy' && !this.falsyTemplate && this.currentNodes) {
      this.syncCurrentNodesFromDom();
    }
    if (nextBranch === 'falsy' && !this.falsyTemplate && this.currentNodes && this.currentNodes.length > 0) {
      removeNodes(this.currentNodes);
      this.currentNodes.length = 0;
    }

    const nodes = instance?.nodes ?? [];
    if (this.activeBranch !== nextBranch) {
      appendNodesBeforeAnchor(parent, this.node, nodes);
      instance?.activate();
    }

    this.syncCurrentNodesFromDom();
    this.activeBranch = nextBranch;
  }

  destroy(): void {
    this.truthyInstance?.destroy();
    this.truthyInstance = null;
    this.falsyInstance?.destroy();
    this.falsyInstance = null;
    if (this.currentNodes) {
      this.syncCurrentNodesFromDom();
      removeNodes(this.currentNodes);
      releaseSlotNodeBuffer(this.currentNodes);
      this.currentNodes = null;
    }

    if (this.startAnchor?.parentNode) {
      this.startAnchor.parentNode.removeChild(this.startAnchor);
    }
    this.startAnchor = null;

    this.activeBranch = null;
  }
}

const resolveTeleportTarget = (value: unknown): Element | null => {
  if (value instanceof Element) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return document.querySelector(value);
  }

  return null;
};

export class TeleportSlot implements Slot<unknown> {
  readonly type = 'teleport';
  readonly frequency = 'normal';
  private mountedNodes: Node[] | null = acquireSlotNodeBuffer();
  private currentTarget: Element | null = null;
  private currentBindingInstance: MountedBindingInstance | null = null;

  constructor(
    public readonly node: Comment,
    private readonly template: StaticTemplate,
    public readonly index: number
  ) {}

  private ensureMountedNodes(): Node[] {
    this.mountedNodes ??= acquireSlotNodeBuffer();
    return this.mountedNodes;
  }

  hydrate(nodes: readonly Node[], target: unknown): void {
    // hydration 只记录已存在节点和当前目标，不在这里搬运节点，避免打断 SSR 产物。
    this.ensureMountedNodes().push(...nodes);
    this.currentTarget = resolveTeleportTarget(target);
  }

  write(value: unknown): void {
    const isBlockPayload =
      typeof value === 'object' &&
      value !== null &&
      (value as Record<string, unknown>).__lania_teleport === 'block';
    const nextTarget = resolveTeleportTarget(
      isBlockPayload ? (value as Record<string, unknown>).target : value
    );
    if (!nextTarget) {
      this.destroy();
      return;
    }

    const bindings = isBlockPayload
      ? (((value as Record<string, unknown>).bindings as TemplateBindingPayload[] | undefined) ?? [])
      : [];
    if (!this.currentBindingInstance) {
      // 首次写入优先尝试接管仍挂在 DOM 上的 hydrated 节点，否则退化为重新挂载模板。
      const hydratedNodes = this.mountedNodes?.filter((node) => node.parentNode !== null) ?? [];
      this.currentBindingInstance =
        hydratedNodes.length > 0
          ? mountHydratedBinding(hydratedNodes, this.template, bindings)
          : mountTemplateBinding(this.template, bindings);
      const mountedNodes = this.ensureMountedNodes();
      mountedNodes.length = 0;
      mountedNodes.push(...this.currentBindingInstance.nodes);
    } else {
      // 目标未变化时只刷新模板绑定，不主动动节点位置。
      this.currentBindingInstance.update();
    }

    if (!this.currentTarget || this.currentTarget !== nextTarget) {
      // 只有 teleport 目标首次确定或发生切换时，才把节点整体迁移到新容器，
      // 避免每次普通 update 都触发一次无意义的 DOM 搬运。
      this.currentBindingInstance.nodes.forEach((node) => {
        nextTarget.appendChild(node);
      });
    }

    // 目标稳定后只更新记录，不再重复搬运节点。
    this.currentTarget = nextTarget;
  }

  destroy(): void {
    this.currentBindingInstance?.destroy();
    this.currentBindingInstance = null;
    if (this.mountedNodes) {
      // Teleport 销毁时要把目标容器里的真实节点一并移除，而不只是清理当前位置注释锚点。
      removeNodes(this.mountedNodes);
      releaseSlotNodeBuffer(this.mountedNodes);
      this.mountedNodes = null;
    }

    this.currentTarget = null;
  }
}
