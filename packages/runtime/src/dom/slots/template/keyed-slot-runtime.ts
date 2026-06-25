/**
 * 处理 keyed `for` 模板块的实例创建、移动与 hydration。
 *
 * 这些工具围绕带开始/结束注释锚点的 block 工作，供 `ForSlot` 在 diff 时复用。
 */
import { collectKeyedBlockNodes } from '../core';
import { mountHydratedBinding, mountTemplateBinding } from './template-factory';
import type {
  KeyedBlock,
  KeyedSlotInstance,
  KeyedSlotPayload,
  MountedBindingInstance,
  SlotListPayload,
} from './template-types';

// 正常挂载路径直接创建 binding 实例并把 fragment 插入到 block 结束锚点前。
export const createKeyedSlotInstance = (
  parent: Node,
  block: KeyedBlock,
  payload: KeyedSlotPayload,
  item: unknown,
  index: number
): KeyedSlotInstance => {
  const instance = mountTemplateBinding(payload.template, payload.bindings, item, index);
  parent.insertBefore(instance.fragment, block.end);
  return {
    mounted: instance.mounted,
    nodes: instance.nodes,
    slots: instance.slots,
    update(item: unknown, index: number) {
      instance.update(item, index);
    },
    activate() {
      instance.activate();
    },
    deactivate() {
      instance.deactivate();
    },
    destroy() {
      instance.destroy();
    },
  };
};

// hydration 场景优先复用 block 区间内已有节点，缺失时再退回全新挂载。
export const createHydratedKeyed = (
  payload: KeyedSlotPayload,
  block: KeyedBlock,
  item: unknown,
  index: number
): KeyedSlotInstance => {
  const hydratedNodes = collectKeyedBlockNodes(block);
  const instance =
    hydratedNodes.length > 0
      ? mountHydratedBinding(hydratedNodes, payload.template, payload.bindings)
      : mountTemplateBinding(payload.template, payload.bindings, item, index);

  instance.update(item, index);

  return {
    mounted: instance.mounted,
    nodes: instance.nodes,
    slots: instance.slots,
    update(nextItem: unknown, nextIndex: number) {
      instance.update(nextItem, nextIndex);
    },
    activate() {
      instance.activate();
    },
    deactivate() {
      instance.deactivate();
    },
    destroy() {
      instance.destroy();
    },
  };
};

// SSR 回填时通过注释对扫描出一组组 hydrated keyed block。
export const collectHydratedKeyedBlocks = (nodes: readonly Node[]): KeyedBlock[] => {
  const blocks: KeyedBlock[] = [];
  let pendingStart: Comment | null = null;

  nodes.forEach((node) => {
    if (!(node instanceof Comment)) {
      return;
    }
    if (node.data === 'lania-for:start') {
      pendingStart = node;
      return;
    }
    if (node.data === 'lania-for:end' && pendingStart) {
      blocks.push({
        key: Symbol('hydrated-keyed-block'),
        start: pendingStart,
        end: node,
        value: undefined,
      });
      pendingStart = null;
    }
  });

  return blocks;
};

export const createSlotListInstance = (
  payload: SlotListPayload,
  item: unknown,
  index: number
): MountedBindingInstance => {
  return mountTemplateBinding(payload.template, payload.bindings, item, index);
};

export const removeKeyedBlock = (parent: Node, block: KeyedBlock): void => {
  let current: ChildNode | null = block.start;
  while (current) {
    const next: ChildNode | null = current.nextSibling;
    parent.removeChild(current);
    if (current === block.end) {
      break;
    }
    current = next;
  }
};

export const replaceKeyedContent = (
  parent: Node,
  block: KeyedBlock,
  nodes: readonly Node[]
): void => {
  // Remove everything between start and end (exclusive).
  while (block.start.nextSibling && block.start.nextSibling !== block.end) {
    parent.removeChild(block.start.nextSibling);
  }

  nodes.forEach((node) => {
    parent.insertBefore(node, block.end);
  });
};

// 移动 block 时要防御 beforeNode 落在 block 内部的异常引用。
export const moveKeyedBlockBefore = (
  parent: Node,
  block: KeyedBlock,
  beforeNode: ChildNode | null
): void => {
  let resolvedBeforeNode =
    beforeNode && beforeNode.parentNode === parent ? beforeNode : null;

  // Defensive: if the reference node is inside the block range we are moving,
  // it will be detached while building the fragment, causing `insertBefore` to throw.
  // Fall back to appending to keep updates alive under unusual host/anchor movements.
  if (
    resolvedBeforeNode &&
    block.start.parentNode === parent &&
    block.end.parentNode === parent
  ) {
    if (resolvedBeforeNode === block.start || resolvedBeforeNode === block.end) {
      resolvedBeforeNode = null;
    } else {
      const startToBefore = block.start.compareDocumentPosition(resolvedBeforeNode);
      const beforeToEnd = resolvedBeforeNode.compareDocumentPosition(block.end);
      const isAfterStart = Boolean(startToBefore & Node.DOCUMENT_POSITION_FOLLOWING);
      const isBeforeEnd = Boolean(beforeToEnd & Node.DOCUMENT_POSITION_FOLLOWING);
      if (isAfterStart && isBeforeEnd) {
        resolvedBeforeNode = null;
      }
    }
  }
  // If already positioned immediately before `beforeNode`, no-op.
  if (resolvedBeforeNode && block.end.nextSibling === resolvedBeforeNode) {
    return;
  }

  const fragment = document.createDocumentFragment();
  let current: ChildNode | null = block.start;
  while (current) {
    const next: ChildNode | null = current.nextSibling;
    fragment.appendChild(current);
    if (current === block.end) {
      break;
    }
    current = next;
  }
  const safeBeforeNode =
    resolvedBeforeNode && resolvedBeforeNode.parentNode === parent ? resolvedBeforeNode : null;
  parent.insertBefore(fragment, safeBeforeNode);
};
