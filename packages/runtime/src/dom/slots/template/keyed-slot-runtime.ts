/**
 * 处理 keyed `for` 模板块的实例创建、移动与 hydration。
 *
 * 这些工具围绕带开始/结束注释锚点的 block 工作，供 `ForSlot` 在 diff 时复用。
 */
import { collectKeyedBlockNodes } from '../core';
import {
  mountHydratedBinding,
  mountTemplateBinding,
  mountTemplateBindingInto,
} from './template-factory';
import type {
  KeyedBlock,
  KeyedSlotInstance,
  KeyedSlotPayload,
  MountedBindingInstance,
  SlotListPayload,
} from './template-types';

// MountedBindingInstance 已经满足 KeyedSlotInstance 的结构（多一个 fragment），
// 直接复用同一个对象，避免每条 item 再包一层闭包壳。
const toKeyedSlotInstance = (
  instance: MountedBindingInstance
): KeyedSlotInstance => instance;

// 正常挂载路径直接创建 binding 实例并把 fragment 插入到给定锚点前。
export const createKeyedSlotInstance = (
  parent: Node,
  anchor: Node | null,
  payload: KeyedSlotPayload,
  item: unknown,
  index: number
): KeyedSlotInstance => {
  const instance = mountTemplateBinding(
    payload.template,
    payload.bindings,
    item,
    index
  );
  parent.insertBefore(instance.fragment, anchor);
  return toKeyedSlotInstance(instance);
};

/**
 * 把条目模板直接挂载到离屏容器（批量首次挂载路径）。
 * 调用方负责把 block 的边界按正确顺序放进同一容器。
 */
export const createKeyedSlotInstanceInto = (
  container: Node,
  payload: KeyedSlotPayload,
  item: unknown,
  index: number
): KeyedSlotInstance => {
  return toKeyedSlotInstance(
    mountTemplateBindingInto(
      container,
      payload.template,
      payload.bindings,
      item,
      index
    )
  );
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

  return toKeyedSlotInstance(instance);
};

// SSR 回填时通过注释对扫描出一组组 hydrated keyed block。
export const collectHydratedKeyedBlocks = (
  nodes: readonly Node[]
): KeyedBlock[] => {
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
        element: null,
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
  if (block.element) {
    if (block.element.parentNode === parent) {
      parent.removeChild(block.element);
    }
    return;
  }

  const start = block.start;
  if (!start) {
    return;
  }

  let current: ChildNode | null = start;
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
  const start = block.start;
  const end = block.end;

  if (!start || !end) {
    // 元素自锚定模式不参与这条“整段替换”路径（它只用于 keyed-slots）。
    return;
  }

  // Remove everything between start and end (exclusive).
  while (start.nextSibling && start.nextSibling !== end) {
    parent.removeChild(start.nextSibling);
  }

  nodes.forEach((node) => {
    parent.insertBefore(node, end);
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

  if (block.element) {
    const element = block.element;

    // 引用节点若落在元素内部，搬移会抛 NotFoundError，直接退回追加。
    if (resolvedBeforeNode && element.contains(resolvedBeforeNode)) {
      resolvedBeforeNode = null;
    }

    if (
      element.parentNode === parent &&
      element.nextSibling === resolvedBeforeNode
    ) {
      return;
    }

    parent.insertBefore(element, resolvedBeforeNode);
    return;
  }

  const start = block.start;
  const end = block.end;

  if (!start || !end) {
    return;
  }

  // Defensive: if the reference node is inside the block range we are moving,
  // it will be detached while building the fragment, causing `insertBefore` to throw.
  // Fall back to appending to keep updates alive under unusual host/anchor movements.
  if (
    resolvedBeforeNode &&
    start.parentNode === parent &&
    end.parentNode === parent
  ) {
    if (resolvedBeforeNode === start || resolvedBeforeNode === end) {
      resolvedBeforeNode = null;
    } else {
      const startToBefore = start.compareDocumentPosition(resolvedBeforeNode);
      const beforeToEnd = resolvedBeforeNode.compareDocumentPosition(end);
      const isAfterStart = Boolean(
        startToBefore & Node.DOCUMENT_POSITION_FOLLOWING
      );
      const isBeforeEnd = Boolean(
        beforeToEnd & Node.DOCUMENT_POSITION_FOLLOWING
      );
      if (isAfterStart && isBeforeEnd) {
        resolvedBeforeNode = null;
      }
    }
  }
  // If already positioned immediately before `beforeNode`, no-op.
  if (resolvedBeforeNode && end.nextSibling === resolvedBeforeNode) {
    return;
  }

  const fragment = document.createDocumentFragment();
  let current: ChildNode | null = start;
  while (current) {
    const next: ChildNode | null = current.nextSibling;
    fragment.appendChild(current);
    if (current === end) {
      break;
    }
    current = next;
  }
  const safeBeforeNode =
    resolvedBeforeNode && resolvedBeforeNode.parentNode === parent
      ? resolvedBeforeNode
      : null;
  parent.insertBefore(fragment, safeBeforeNode);
};
