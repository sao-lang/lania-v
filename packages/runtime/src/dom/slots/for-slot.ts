/**
 * `ForSlot` 列表渲染运行时。
 *
 * 该文件负责承接编译产物里的 `for` 类结构性 slot，并根据 payload 形态走不同更新路径：
 * - 普通数组：按当前位置复用文本/节点，必要时插入、移动或删除；
 * - `slots`：把每一项交给模板绑定实例，维持实例级 update/destroy 生命周期；
 * - `keyed` / `keyed-slots`：以 key 为稳定身份维护 block，支持重排、hydration 复用和离场交接。
 *
 * 与基础文本 slot 不同，`ForSlot` 需要同时处理“节点集合”和“列表状态”两层问题，
 * 因此会缓存 mounted node buffer、keyed block 映射以及最近一次挂载目标，
 * 以便在 dom-host、KeepAlive、TransitionGroup 等复杂宿主场景下仍能找到正确的插入位置。
 */
import { type DomHostBlockRecord, type DomHostOwner, getDomHostRedirect } from '../../component/host/function-component';
import { resolveAnchorDomTarget } from '../../component/lifecycle/keepalive-registry';
import { acquireSlotNodeBuffer, releaseSlotNodeBuffer } from '../slot-pool';
import {
  appendNodesBeforeAnchor,
  cloneFactoryNodes,
  collectKeyedBlockElements,
  insertNodeBeforeSafe,
  normalizeDynamicResult,
  removeNodes,
  type Slot,
} from './core';
import type {
  KeyedBlock,
  KeyedForPayload,
  KeyedSlotPayload,
  MountedBindingInstance,
  SlotListPayload,
} from './template/template-types';
import {
  collectHydratedKeyedBlocks,
  createHydratedKeyed,
  createKeyedSlotInstance,
  createSlotListInstance,
  moveKeyedBlockBefore,
  removeKeyedBlock,
  replaceKeyedContent,
} from './template/keyed-slot-runtime';

export class ForSlot implements Slot<unknown> {
  readonly type = 'for';
  readonly frequency = 'normal';
  private mountedNodes: Node[] | null = acquireSlotNodeBuffer();
  private keyedBlocks: Map<unknown, KeyedBlock> | null = null;
  private keyedBlockOrder: KeyedBlock[] = [];
  private listInstances: MountedBindingInstance[] = [];
  private lastMountParent: Node | null = null;
  private lastMountAnchor: Comment | null = null;

  constructor(
    public readonly node: Comment,
    public readonly index: number,
    private readonly createFallbackNodes?: () => Node | Node[] | DocumentFragment | null
  ) {}

  // `mountedNodes` 通过缓冲池复用，避免频繁创建数组。
  private ensureMountedNodes(): Node[] {
    this.mountedNodes ??= acquireSlotNodeBuffer();
    return this.mountedNodes;
  }

  hydrate(nodes: readonly Node[]): void {
    // hydration 只接收 SSR 现有节点，真正接管发生在首次 write。
    this.ensureMountedNodes().push(...nodes);
  }

  private destroyKeyedBlocks(): void {
    if (!this.keyedBlocks) {
      return;
    }

    const parent = this.lastMountParent ?? this.node.parentNode;
    if (parent) {
      this.keyedBlocks.forEach((block) => {
        block.instance?.destroy();
        removeKeyedBlock(parent, block);
      });
    }

    this.keyedBlocks.clear();
    this.keyedBlocks = null;
    this.keyedBlockOrder = [];
  }

  private destroyListInstances(): void {
    this.listInstances.forEach((instance) => instance.destroy());
    this.listInstances = [];
  }

  write(value: unknown): void {
    const defaultParent = this.node.parentNode;

    // 在 dom-host 场景里（例如 TransitionGroup 包着结构性 slot），原始锚点注释
    // 可能被重定向、移动，甚至暂时脱离当前 parent。这里不能只依赖 `node.parentNode`，
    // 否则列表 push/pop 会静默失效。
    // 解析顺序为：当前 live parent -> 最近一次成功挂载目标 -> 已注册的 dom-host redirect。
    const fallbackTarget =
      getDomHostRedirect(this.node)
      ?? (this.lastMountParent && this.lastMountAnchor
        ? { parent: this.lastMountParent, anchor: this.lastMountAnchor }
        : null);

    if (!defaultParent && !fallbackTarget) {
      return;
    }

    // 即便锚点已经脱离当前父节点，也继续用原始注释节点解析目标，
    // 这样基于 `this.node` 建立的 redirect 才不会丢失。
    const resolved = defaultParent
      ? resolveAnchorDomTarget({ parent: defaultParent, anchor: this.node })
      : resolveAnchorDomTarget({ parent: fallbackTarget!.parent, anchor: this.node });

    const parent = resolved.parent;
    const anchor = resolved.anchor as Comment;
    const owner = resolved.owner;
    this.lastMountParent = parent;
    this.lastMountAnchor = anchor;

    if (isKeyedSlotPayload(value)) {
      this.applyKeyedSlots(parent, anchor, value, owner);
      return;
    }

    if (isSlotListPayload(value)) {
      this.destroyKeyedBlocks();
      const items = Array.isArray(value.items) ? value.items : [];

      if (items.length === 0) {
        this.destroyListInstances();
        this.destroy();
        if (this.createFallbackNodes) {
          // 空列表时允许回退到编译期提供的 fallback 片段。
          const mountedNodes = this.ensureMountedNodes();
          mountedNodes.push(...cloneFactoryNodes(this.createFallbackNodes));
          appendNodesBeforeAnchor(parent, anchor, mountedNodes);
        }
        return;
      }

      if (this.listInstances.length === 0 && this.mountedNodes && this.mountedNodes.length > 0) {
        removeNodes(this.mountedNodes);
        this.mountedNodes.length = 0;
      }

      const nextInstances: MountedBindingInstance[] = [];
      items.forEach((item, index) => {
        const current = this.listInstances[index];
        if (current) {
          current.update(item, index);
          nextInstances.push(current);
          return;
        }

        const instance = createSlotListInstance(value, item, index);
        nextInstances.push(instance);
        appendNodesBeforeAnchor(parent, anchor, instance.nodes);
      });

      this.listInstances.slice(items.length).forEach((instance) => {
        instance.destroy();
        removeNodes(instance.nodes);
      });
      this.listInstances = nextInstances;
      rebuildNodeBuffer(this.ensureMountedNodes(), this.listInstances);
      return;
    }

    // keyed 路径自己维护 block 状态；普通数组路径则退化成整段节点集合替换。
    if (isKeyedForPayload(value)) {
      // 进入 keyed 模式前先清掉普通列表或 fallback 残留状态。
      this.destroy();
      this.applyKeyed(parent, anchor, value);
      return;
    }

    this.destroyKeyedBlocks();
    this.destroyListInstances();

    const items = Array.isArray(value) ? value : [];

    if (items.length === 0) {
      this.destroy();
      if (this.createFallbackNodes) {
        const mountedNodes = this.ensureMountedNodes();
        mountedNodes.push(...cloneFactoryNodes(this.createFallbackNodes));
        appendNodesBeforeAnchor(parent, anchor, mountedNodes);
      }
      return;
    }

    const currentNodes = this.ensureMountedNodes();
    const nextNodes = items.map((item, index) => {
      const currentNode = currentNodes[index];
      if (item instanceof Node) {
        // 原生 Node 直接复用，让调用方可以手动控制节点身份。
        return item;
      }

      if (currentNode instanceof Text) {
        // 文本位优先原地改写，避免每次都创建新 Text。
        currentNode.data = item == null ? '' : String(item);
        return currentNode;
      }

      return document.createTextNode(item == null ? '' : String(item));
    });

    const nextNodeSet = new Set(nextNodes);
    currentNodes.forEach((node) => {
      if (!nextNodeSet.has(node)) {
        node.parentNode?.removeChild(node);
      }
    });

    let beforeNode: ChildNode | null = anchor;
    for (let index = nextNodes.length - 1; index >= 0; index -= 1) {
      const node = nextNodes[index]!;
      if (node.parentNode !== parent || node.nextSibling !== beforeNode) {
        parent.insertBefore(node, beforeNode);
      }
      beforeNode = node as ChildNode;
    }

    currentNodes.length = 0;
    currentNodes.push(...nextNodes);
  }

  private applyKeyed(parent: Node, anchor: Comment, payload: KeyedForPayload): void {
    const items = Array.isArray(payload.items) ? payload.items : [];

    // keyed 列表为空时，清掉所有 block，再决定是否展示 fallback。
    if (items.length === 0) {
      this.destroyKeyedBlocks();
      if (this.createFallbackNodes) {
        const mountedNodes = this.ensureMountedNodes();
        mountedNodes.push(...cloneFactoryNodes(this.createFallbackNodes));
        appendNodesBeforeAnchor(parent, anchor, mountedNodes);
      }
      return;
    }

    // 进入 keyed 模式后，block map 成为唯一真相来源；旧 fallback 节点要先移除。
    this.destroy();
    this.keyedBlocks ??= new Map();

    const nextKeys = new Set<unknown>();
    const nextOrder: KeyedBlock[] = [];

    items.forEach((item, index) => {
      let key = safeKey(payload.key, item, index);
      // 单次 write 内若 key 重复，追加 index 做退化去重，避免 map 被覆盖。
      if (nextKeys.has(key)) {
        key = `${String(key)}__${index}`;
      }
      nextKeys.add(key);

      let block = this.keyedBlocks!.get(key);
      if (!block) {
        block = createKeyedBlock(key);
        this.keyedBlocks!.set(key, block);
        // 首次出现的 block 先插入边界注释，再填充内容。
        insertNodeBeforeSafe(parent, block.start, anchor);
        insertNodeBeforeSafe(parent, block.end, anchor);
      }

      // 仅在 item 身份变化时重渲染 block，兼容常见的不可变更新模式。
      if (!Object.is(block.value, item)) {
        const rendered = safeRender(payload.render, item, index);
        replaceKeyedContent(parent, block, normalizeDynamicResult(rendered));
        block.value = item;
      }

      nextOrder.push(block);
    });

    // 本轮不存在的 key 需要及时移除对应 block。
    this.keyedBlocks!.forEach((block, key) => {
      if (!nextKeys.has(key)) {
        removeKeyedBlock(parent, block);
        this.keyedBlocks!.delete(key);
      }
    });

    // 统一按 nextOrder 正向重排，`anchor` 作为稳定参考点可避免节点搬移中的临时错位。
    for (let i = 0; i < nextOrder.length; i += 1) {
      const block = nextOrder[i]!;
      moveKeyedBlockBefore(parent, block, anchor);
    }

    this.keyedBlockOrder = nextOrder;
  }

  private applyKeyedSlots(
    parent: Node,
    anchor: Comment,
    payload: KeyedSlotPayload,
    owner?: DomHostOwner
  ): void {
    const items = Array.isArray(payload.items) ? payload.items : [];

    if (items.length === 0) {
      this.destroyKeyedBlocks();
      if (this.createFallbackNodes) {
        const mountedNodes = this.ensureMountedNodes();
        mountedNodes.push(...cloneFactoryNodes(this.createFallbackNodes));
        appendNodesBeforeAnchor(parent, anchor, mountedNodes);
      }
      return;
    }

    const hydratedBlocks =
      this.keyedBlocks == null && this.mountedNodes && this.mountedNodes.length > 0
        ? collectHydratedKeyedBlocks(this.mountedNodes)
        : [];
    const availableHydratedBlocks = [...hydratedBlocks];

    if (
      availableHydratedBlocks.length === 0 &&
      this.tryApplyStableKeyedSlots(parent, anchor, payload, items, owner)
    ) {
      return;
    }

    // hydration 命中 block 边界时，优先把 SSR 现有 block 接管为 keyed 状态。
    if (availableHydratedBlocks.length > 0) {
      this.destroyListInstances();
      this.mountedNodes?.splice(0, this.mountedNodes.length);
    } else {
      this.destroy();
    }
    this.keyedBlocks ??= new Map();

    const previousKeyOrder = [...this.keyedBlocks.keys()];
    const previousIndexByKey = new Map(previousKeyOrder.map((key, index) => [key, index]));
    const nextKeys = new Set<unknown>();
    const nextOrder: KeyedBlock[] = [];
    let isStableOrder = previousKeyOrder.length === items.length;
    const createBlockRecord = (block: KeyedBlock, initialParent: Node): DomHostBlockRecord => {
      const record: DomHostBlockRecord = {
        key: block.key,
        parent: initialParent,
        start: block.start,
        end: block.end,
        getElements: () => collectKeyedBlockElements(block),
        moveBefore: (referenceNode: Node | null) => {
          const currentParent = block.start.parentNode;
          if (!currentParent) {
            return;
          }
          moveKeyedBlockBefore(currentParent, block, referenceNode as ChildNode | null);
        },
        finalizeRemoval: () => {
          const currentParent = block.start.parentNode;
          if (!currentParent) {
            return;
          }
          if (block.end.parentNode !== currentParent) {
            // Best-effort cleanup under unexpected DOM manipulations.
            block.start.parentNode?.removeChild(block.start);
            block.end.parentNode?.removeChild(block.end);
            return;
          }
          removeKeyedBlock(currentParent, block);
        },
        destroyBindings: () => block.instance?.destroy(),
      };
      return record;
    };

    items.forEach((item, index) => {
      let key = safeKey(payload.key, item, index);
      if (nextKeys.has(key)) {
        key = `${String(key)}__${index}`;
      }
      nextKeys.add(key);
      if (isStableOrder && previousKeyOrder[index] !== key) {
        isStableOrder = false;
      }

      let block = this.keyedBlocks!.get(key);
      const previousIndex = previousIndexByKey.get(key);
      let shouldUpdateBlock = false;
      if (!block) {
        const hydratedBlock = availableHydratedBlocks.shift();
        block = hydratedBlock
          ? {
              ...hydratedBlock,
              key,
            }
          : createKeyedBlock(key);
        this.keyedBlocks!.set(key, block);
        if (!hydratedBlock) {
          insertNodeBeforeSafe(parent, block.start, anchor);
          insertNodeBeforeSafe(parent, block.end, anchor);
          block.instance = createKeyedSlotInstance(parent, block, payload, item, index);
        } else {
          // 命中 SSR block 时，不重建边界，只补齐 hydrated 实例控制器。
          block.instance = createHydratedKeyed(payload, block, item, index);
        }
      } else {
        // block 之前若被挂到别处或暂时脱离页面，这里要先重新接回当前 parent，
        // 否则后续 update 只会改“不可见的旧节点”。
        if (block.start.parentNode !== parent || block.end.parentNode !== parent) {
          insertNodeBeforeSafe(parent, block.start, anchor);
          insertNodeBeforeSafe(parent, block.end, anchor);
        }
        if (!block.instance) {
          block.instance = createKeyedSlotInstance(parent, block, payload, item, index);
        } else {
          shouldUpdateBlock = !Object.is(block.value, item) || previousIndex !== index;
          // 内容节点也要确保仍位于 end marker 前，维持 block 边界闭包。
          const end = block.end;
          block.instance.nodes.forEach((node) => {
            if (node.parentNode !== parent) {
              insertNodeBeforeSafe(parent, node, end);
            } else if (node.nextSibling !== end) {
              // DOM 会自动搬移节点，因此可以直接用 insertBefore 纠正顺序。
              insertNodeBeforeSafe(parent, node, end);
            }
          });
        }
      }

      if (shouldUpdateBlock) {
        block.instance?.update(item, index);
      }
      block.value = item;
      block.record ??= createBlockRecord(block, parent);
      owner?.registerActiveBlock?.(block.record);
      nextOrder.push(block);
    });

    this.keyedBlocks!.forEach((block, key) => {
      if (!nextKeys.has(key)) {
        block.record ??= createBlockRecord(block, parent);
        const handedOff =
          owner?.handoffRemovedBlock?.({
            key,
            previousIndex: previousKeyOrder.indexOf(key),
            block: block.record,
          }) ?? false;
        if (handedOff) {
          this.keyedBlocks!.delete(key);
          return;
        }
        block.instance?.destroy();
        removeKeyedBlock(parent, block);
        this.keyedBlocks!.delete(key);
      }
    });

    if (!isStableOrder) {
      for (let i = 0; i < nextOrder.length; i += 1) {
        const block = nextOrder[i]!;
        moveKeyedBlockBefore(parent, block, anchor);
      }
    }

    this.keyedBlockOrder = nextOrder;
  }

  private tryApplyStableKeyedSlots(
    parent: Node,
    anchor: Comment,
    payload: KeyedSlotPayload,
    items: readonly unknown[],
    owner?: DomHostOwner
  ): boolean {
    if (!this.keyedBlocks || this.keyedBlockOrder.length !== items.length || items.length === 0) {
      return false;
    }

    const currentOrder = this.keyedBlockOrder;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const key = safeKey(payload.key, item, index);
      const block = currentOrder[index];
      if (!block || block.key !== key || this.keyedBlocks.get(key) !== block) {
        return false;
      }
    }

    const createBlockRecord = (block: KeyedBlock, initialParent: Node): DomHostBlockRecord => {
      const record: DomHostBlockRecord = {
        key: block.key,
        parent: initialParent,
        start: block.start,
        end: block.end,
        getElements: () => collectKeyedBlockElements(block),
        moveBefore: (referenceNode: Node | null) => {
          const currentParent = block.start.parentNode;
          if (!currentParent) {
            return;
          }
          moveKeyedBlockBefore(currentParent, block, referenceNode as ChildNode | null);
        },
        finalizeRemoval: () => {
          const currentParent = block.start.parentNode;
          if (!currentParent) {
            return;
          }
          if (block.end.parentNode !== currentParent) {
            block.start.parentNode?.removeChild(block.start);
            block.end.parentNode?.removeChild(block.end);
            return;
          }
          removeKeyedBlock(currentParent, block);
        },
        destroyBindings: () => block.instance?.destroy(),
      };
      return record;
    };

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const block = currentOrder[index]!;

      if (block.start.parentNode !== parent || block.end.parentNode !== parent) {
        insertNodeBeforeSafe(parent, block.start, anchor);
        insertNodeBeforeSafe(parent, block.end, anchor);
      }

      if (!block.instance) {
        block.instance = createKeyedSlotInstance(parent, block, payload, item, index);
      } else {
        const end = block.end;
        block.instance.nodes.forEach((node) => {
          if (node.parentNode !== parent || node.nextSibling !== end) {
            insertNodeBeforeSafe(parent, node, end);
          }
        });
        if (!Object.is(block.value, item)) {
          block.instance.update(item, index);
        }
      }

      block.value = item;
      block.record ??= createBlockRecord(block, parent);
      owner?.registerActiveBlock?.(block.record);
    }

    return true;
  }

  destroy(): void {
    this.destroyListInstances();
    if (!this.mountedNodes) {
      return;
    }

    removeNodes(this.mountedNodes);
    releaseSlotNodeBuffer(this.mountedNodes);
    this.mountedNodes = null;
  }
}

const rebuildNodeBuffer = (
  target: Node[] | null,
  instances: readonly MountedBindingInstance[]
): Node[] | null => {
  if (!target) {
    return target;
  }

  target.length = 0;
  instances.forEach((instance) => {
    target.push(...instance.nodes);
  });
  return target;
};

const isKeyedForPayload = (value: unknown): value is KeyedForPayload => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.__lania_for === 'keyed' &&
    typeof record.render === 'function' &&
    typeof record.key === 'function' &&
    'items' in record
  );
};

const isKeyedSlotPayload = (value: unknown): value is KeyedSlotPayload => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.__lania_for === 'keyed-slots' &&
    typeof record.key === 'function' &&
    typeof record.template === 'object' &&
    Array.isArray(record.bindings) &&
    'items' in record
  );
};

const isSlotListPayload = (value: unknown): value is SlotListPayload => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.__lania_for === 'slots' &&
    typeof record.template === 'object' &&
    Array.isArray(record.bindings) &&
    'items' in record
  );
};

const safeKey = (
  keyFn: (item: unknown, index: number) => unknown,
  item: unknown,
  index: number
): unknown => {
  try {
    const key = keyFn(item, index);
    return key == null ? index : key;
  } catch {
    return index;
  }
};

const safeRender = (
  renderFn: (item: unknown, index: number) => unknown,
  item: unknown,
  index: number
): unknown => {
  try {
    return renderFn(item, index);
  } catch {
    return null;
  }
};

const createKeyedBlock = (key: unknown): KeyedBlock => {
  return {
    key,
    start: document.createComment('lania-for:start'),
    end: document.createComment('lania-for:end'),
    value: undefined,
  };
};
