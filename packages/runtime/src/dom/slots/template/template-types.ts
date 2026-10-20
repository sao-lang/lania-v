/**
 * 定义模板绑定运行时共享的数据结构。
 *
 * 包括编译期 payload 形状、挂载实例协议、boundary 区间工具以及 KeepAlive/Transition
 * 读取节点时会复用的辅助函数。
 */
import type { DomHostBlockRecord } from '../../../component/host/function-component';
import type { MountedStaticTemplate, StaticTemplate } from '../../../render/types';
import type { Slot } from '../core';
import { collectKeyedBlockNodes, reconcileNodesBeforeAnchor } from '../core';

export type KeyedForPayload = {
  __lania_for: 'keyed';
  items: unknown;
  render: (item: unknown, index: number) => unknown;
  key: (item: unknown, index: number) => unknown;
};

export type KeyedBlock = {
  key: unknown;
  /**
   * 注释锚点模式：`start` / `end` 包围 block 内容，`element` 为 null。
   * 元素自锚定模式：`element` 指向唯一条目根元素，两个锚点均为 null。
   * 后者用于没有过渡/保活宿主钩子的普通列表，省掉每条 item 两个注释节点。
   */
  start: Comment | null;
  end: Comment | null;
  element: Element | null;
  value: unknown;
  instance?: KeyedSlotInstance;
  record?: DomHostBlockRecord;
};

// 每个 binding payload 都描述了槽位位置、求值函数以及可选附加配置。
export type TemplateBindingPayload = {
  kind:
    | 'text'
    | 'attr'
    | 'prop'
    | 'class'
    | 'style'
    | 'event'
    | 'directive'
    | 'ref'
    | 'for'
    | 'if'
    | 'dynamic'
    | 'boundary'
    | 'teleport'
    | 'keepalive';
  slotIndex: number;
  path: readonly number[];
  evaluate: (...args: unknown[]) => unknown;
  name?: string;
  unit?: string;
  modifiers?: readonly string[];
  listener?: {
    once?: boolean;
    capture?: boolean;
    passive?: boolean;
  };
  /** 提示性修饰符（`debounce` / `throttle`），需要额外监听才能生效。 */
  hints?: readonly string[];
  template?: StaticTemplate;
  fallbackTemplate?: StaticTemplate;
  directiveKind?: 'bind' | 'model' | 'html' | 'class' | 'style' | 'use' | 'ref' | 'unknown' | 'if';
};

export type KeyedSlotPayload = {
  __lania_for: 'keyed-slots';
  items: unknown;
  key: (item: unknown, index: number) => unknown;
  template: StaticTemplate;
  bindings: readonly TemplateBindingPayload[];
};

export type SlotListPayload = {
  __lania_for: 'slots';
  items: unknown;
  template: StaticTemplate;
  bindings: readonly TemplateBindingPayload[];
};

export type IfBlockPayload = {
  __lania_if: 'block';
  when: unknown;
  mode?: 'retain' | 'remount';
  truthyBindings?: readonly TemplateBindingPayload[];
  falsyBindings?: readonly TemplateBindingPayload[];
};

export type BoundaryBlockPayload = {
  __lania_boundary: 'block';
  payload?: unknown;
  bindings?: readonly TemplateBindingPayload[];
};

export type BoundarySlotRangeHost = {
  rangeStart: Comment;
  rangeEnd: Comment;
  parentBoundaryReplay: (() => void) | null;
};

export type MountedBindingInstance = {
  nodes: Node[];
  mounted: MountedStaticTemplate;
  slots: Slot<unknown>[];
  update(...args: unknown[]): void;
  activate(): void;
  deactivate(): void;
  destroy(): void;
};

/** 带临时 fragment 的挂载实例；只有需要整体搬运节点的调用方会用到。 */
export type MountedFragmentBindingInstance = MountedBindingInstance & {
  fragment: DocumentFragment;
};

// 结构型 slot 暴露的节点可能只是“内容”，而锚点仍然记录在 instance.nodes 里。
// 把两部分按文档顺序合并，才能保证搬移后嵌套 slot 仍能通过锚点定位自己的区间。
const mergeNodesInDocumentOrder = (nodes: readonly Node[]): Node[] => {
  const unique = [...new Set(nodes)];
  unique.sort((left, right) => {
    if (left === right) {
      return 0;
    }
    return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  return unique;
};

// 优先返回真实仍挂在 DOM 中的节点；结构型 slot 需要特殊读取其内部节点。
export const readMountedNodes = (instance: MountedBindingInstance): Node[] => {
  const liveNodes = instance.nodes.filter((node) => node.parentNode !== null);
  if (instance.slots.length === 1) {
    const slot = instance.slots[0] as {
      currentNodes?: Node[] | null;
      mountedNodes?: Node[] | null;
      collectMountedNodes?: () => Node[];
    };
    const structuralNodes = slot.collectMountedNodes
      ? slot.collectMountedNodes()
      : (slot.currentNodes ?? slot.mountedNodes);
    if (structuralNodes) {
      const liveStructuralNodes = structuralNodes.filter((node) => node.parentNode !== null);
      if (
        liveNodes.length === 1 &&
        liveNodes[0] instanceof Element &&
        liveStructuralNodes.length > 0 &&
        liveStructuralNodes.every((node) => liveNodes[0]!.contains(node))
      ) {
        return liveNodes;
      }
      if (liveStructuralNodes.length > 0) {
        // 排除已经被 instance 节点包含的结构节点，避免同一个元素被搬移两次。
        const detachedStructuralNodes = liveStructuralNodes.filter(
          (node) => !liveNodes.some((liveNode) => liveNode !== node && liveNode.contains(node))
        );
        if (liveNodes.length > 0 && detachedStructuralNodes.length > 0) {
          return mergeNodesInDocumentOrder([...liveNodes, ...detachedStructuralNodes]);
        }
        return detachedStructuralNodes.length > 0 ? detachedStructuralNodes : liveStructuralNodes;
      }
      if (liveNodes.length > 0) {
        return liveNodes;
      }
      return structuralNodes;
    }
  }

  if (liveNodes.length > 0) {
    return liveNodes;
  }

  return instance.nodes;
};

export const createBoundarySlotRangeHost = (): BoundarySlotRangeHost => {
  return {
    rangeStart: document.createComment('lania-boundary:start'),
    rangeEnd: document.createComment('lania-boundary:end'),
    parentBoundaryReplay: null,
  };
};

export const readRangeContentNodes = (
  host: BoundarySlotRangeHost,
  currentNodes: readonly Node[]
): Node[] => {
  return currentNodes.filter((node) => node !== host.rangeStart && node !== host.rangeEnd);
};

// boundary slot 依赖一对 range anchor 包裹内容，便于 replay 与局部替换。
export const ensureRangeAnchors = (
  host: BoundarySlotRangeHost,
  anchor: Comment,
  currentNodes: readonly Node[],
  preferredContentNodes: readonly Node[] = []
): Node | null => {
  const parent = anchor.parentNode;
  if (!parent) {
    return null;
  }

  if (host.rangeEnd.parentNode !== parent) {
    parent.insertBefore(host.rangeEnd, anchor);
  }

  if (host.rangeStart.parentNode !== parent) {
    const firstContentNode =
      preferredContentNodes.find((node) => node.parentNode === parent) ??
      readRangeContentNodes(host, currentNodes).find((node) => node.parentNode === parent) ??
      host.rangeEnd;
    parent.insertBefore(host.rangeStart, firstContentNode);
  }

  return parent;
};

export const hydrateSlotRange = (
  host: BoundarySlotRangeHost,
  anchor: Comment,
  currentNodes: Node[],
  nodes: readonly Node[]
): void => {
  currentNodes.length = 0;
  currentNodes.push(host.rangeStart, ...nodes, host.rangeEnd);
  ensureRangeAnchors(host, anchor, currentNodes, nodes);
};

export const canReplayBoundarySlotRange = (
  host: BoundarySlotRangeHost,
  lastValue: BoundaryBlockPayload | null
): boolean => {
  return (
    lastValue !== null &&
    host.rangeStart.parentNode !== null &&
    host.rangeStart.parentNode === host.rangeEnd.parentNode
  );
};

export const renderBoundarySlotRange = (
  host: BoundarySlotRangeHost,
  anchor: Comment,
  currentNodes: Node[],
  nextNodes: readonly Node[]
): void => {
  const currentContentNodes = readRangeContentNodes(host, currentNodes);
  const parent = ensureRangeAnchors(host, anchor, currentNodes, nextNodes);
  if (!parent) {
    currentNodes.splice(0, currentNodes.length, host.rangeStart, ...nextNodes, host.rangeEnd);
    return;
  }

  reconcileNodesBeforeAnchor(parent, host.rangeEnd, currentContentNodes, nextNodes);
  currentNodes.splice(0, currentNodes.length, host.rangeStart, ...nextNodes, host.rangeEnd);
};

export const replayBoundarySlotHost = (
  host: BoundarySlotRangeHost,
  lastValue: BoundaryBlockPayload | null,
  replaySelf: () => void
): void => {
  if (host.parentBoundaryReplay) {
    host.parentBoundaryReplay();
    return;
  }

  if (canReplayBoundarySlotRange(host, lastValue)) {
    replaySelf();
  }
};

export const attachNestedReplay = (
  host: BoundarySlotRangeHost,
  instance: MountedBindingInstance | null,
  readLastValue: () => BoundaryBlockPayload | null,
  replaySelf: () => void
): void => {
  if (!instance) {
    return;
  }

  const replay = () => {
    replayBoundarySlotHost(host, readLastValue(), replaySelf);
  };

  instance.slots.forEach((slot) => {
    const boundarySlot = slot as Slot<unknown> & {
      setParentBoundaryReplay?: (replay: (() => void) | null) => void;
    };
    boundarySlot.setParentBoundaryReplay?.(replay);
  });
};

export const readTransitionChildNodes = (instance: MountedBindingInstance): Node[] => {
  if (instance.slots.length === 1) {
    const structuralNodes = readMountedNodes(instance);
    const hasConcreteWrapperNode = structuralNodes.some((node) => node.nodeType !== Node.COMMENT_NODE);
    if (hasConcreteWrapperNode) {
      return structuralNodes;
    }
    const slot = instance.slots[0] as {
      currentNodes?: Node[] | null;
      mountedNodes?: Node[] | null;
    };
    return (slot.currentNodes ?? slot.mountedNodes ?? []).slice();
  }

  return readMountedNodes(instance);
};

// KeepAlive 需要尽量完整追踪嵌套 slot 暴露的结构节点，避免只缓存外层注释锚点。
export const readKeepAliveEntryNodes = (instance: MountedBindingInstance): Node[] => {
  const trackedNodes: Node[] = [];
  const seen = new Set<Node>();
  const pushUnique = (nodes: readonly Node[] | null | undefined): void => {
    nodes?.forEach((node) => {
      if (!seen.has(node)) {
        seen.add(node);
        trackedNodes.push(node);
      }
    });
  };

  instance.slots.forEach((slot) => {
    const structuralSlot = slot as {
      currentNodes?: Node[] | null;
      mountedNodes?: Node[] | null;
      keyedBlocks?: Map<unknown, KeyedBlock> | null;
    };
    pushUnique(structuralSlot.currentNodes);
    pushUnique(structuralSlot.mountedNodes);
    structuralSlot.keyedBlocks?.forEach((block) => {
      pushUnique([
        ...(block.start ? [block.start] : []),
        ...collectKeyedBlockNodes(block),
        ...(block.end ? [block.end] : []),
      ]);
      pushUnique(block.instance?.nodes);
    });

    // Some slots own nested binding instances (dynamic/teleport/if/keepalive). When KeepAlive
    // de/activates an entry, we must track the live nested nodes as well; otherwise we can
    // end up committing only outer markers and "lose" the real DOM produced by nested slots.
    //
    // IMPORTANT: if a slot exposes a wrapper element (e.g. TransitionGroup dom-host returns a <ul>),
    // tracking both the wrapper and its nested nodes would cause KeepAlive to move children out of
    // the wrapper. We only skip the dive when nested nodes are fully contained by a single wrapper.
    const exposedNodes = structuralSlot.currentNodes ?? structuralSlot.mountedNodes ?? null;
    const exposedElements = (exposedNodes ?? []).filter(
      (node): node is Element => node instanceof Element
    );

    const nestedInstances: Array<MountedBindingInstance | null | undefined> = [
      (slot as unknown as { currentChildInstance?: MountedBindingInstance | null }).currentChildInstance,
      (slot as unknown as { currentBindingInstance?: MountedBindingInstance | null }).currentBindingInstance,
      (slot as unknown as { truthyInstance?: MountedBindingInstance | null }).truthyInstance,
      (slot as unknown as { falsyInstance?: MountedBindingInstance | null }).falsyInstance,
    ];

    // If there is exactly one exposed element and all nested nodes are descendants of it,
    // keep tracking shallowly to preserve container->children relationship.
    if (exposedElements.length === 1) {
      const root = exposedElements[0]!;
      const nestedNodes = nestedInstances
        .flatMap((nested) => nested?.nodes ?? [])
        .filter((node) => node.parentNode !== null);
      if (nestedNodes.length > 0 && nestedNodes.every((node) => root.contains(node))) {
        return;
      }
    }

    nestedInstances.forEach((nested) => {
      if (!nested) {
        return;
      }
      pushUnique(nested.nodes);
      // Pull one more layer of structural nodes if present.
      nested.slots.forEach((nestedSlot) => {
        const nestedStructural = nestedSlot as {
          currentNodes?: Node[] | null;
          mountedNodes?: Node[] | null;
        };
        pushUnique(nestedStructural.currentNodes);
        pushUnique(nestedStructural.mountedNodes);
      });
    });
  });

  if (trackedNodes.length > 0) {
    pushUnique(instance.nodes);
    const liveTrackedNodes = trackedNodes.filter((node) => node.parentNode !== null);
    return liveTrackedNodes.length > 0 ? liveTrackedNodes : trackedNodes;
  }

  return readMountedNodes(instance);
};

export type KeyedSlotInstance = MountedBindingInstance;

export type RetainedSlotLifecycle = {
  activate(): void;
  deactivate(): void;
};
