/**
 * TransitionGroup snapshot 显示层组装。
 *
 * 这层位于 state publish 与最终 renderable 之间，负责把“当前快照”和“仍在离场中的快照”
 * 合成为一次可直接返回给上层的 display 结果。
 *
 * 主要职责有三类：
 * - 按 previousIndex 把 leaving snapshot 插回稳定位置，维持离场动画所需的视觉顺序；
 * - 根据 transition tag 决定返回裸条目数组还是包裹容器；
 * - 在已有容器可复用时尽量原位同步 childNodes，保住正在复用或离场的真实节点实例。
 *
 * 它不决定谁进入、谁离开，只把状态层已经算好的展示结果落到最终输出形态上。
 */
import { getTransitionGroupState } from '../state/store';
import { publishGroupState } from '../state/state';
import type { GroupLeavingSnapshot } from '../types';

// 当前快照和 leaving 快照会被合成一个“展示列表”；离场项按原始 previousIndex 插回。
export const buildGroupDisplay = <TRenderable>(
  currentSnapshots: readonly TRenderable[],
  leavingSnapshots: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>
): TRenderable[] => {
  const display = [...currentSnapshots];
  [...leavingSnapshots.values()]
    .sort((left, right) => left.previousIndex - right.previousIndex)
    .forEach((entry) => {
      const insertAt = Math.max(
        0,
        Math.min(entry.previousIndex, display.length)
      );
      display.splice(insertAt, 0, entry.snapshot);
    });
  return display;
};

// 把一组 display entries 追加进容器；非 Node 值会退化成 Text 节点。
const appendDisplayEntries = <TRenderable>(
  host: HTMLElement,
  entries: readonly TRenderable[]
): void => {
  entries.forEach((entry) => {
    if (entry instanceof Node) {
      host.appendChild(entry);
      return;
    }

    host.appendChild(document.createTextNode(String(entry)));
  });
};

// TransitionGroup 配置了 tag 时，需要把 display 包进一个真实容器元素；否则直接返回条目数组。
export const wrapDisplayWithTag = <TRenderable>(
  tag: string | undefined,
  entries: readonly TRenderable[]
): TRenderable[] | HTMLElement => {
  if (!tag || tag.trim().length === 0) {
    return [...entries];
  }

  const element = document.createElement(tag);
  appendDisplayEntries(element, entries);
  return element;
};

// 在已有容器上做最小化同步：删掉不再需要的 child，再把需要的节点按顺序插回。
export const syncDisplayContainer = <TRenderable>(
  container: HTMLElement,
  entries: readonly TRenderable[]
): void => {
  const nextNodes: Node[] = [];
  entries.forEach((entry) => {
    nextNodes.push(
      entry instanceof Node ? entry : document.createTextNode(String(entry))
    );
  });
  // 这里不做 keyed diff，而是尽量复用现有 Node 实例，再靠 appendChild/insertBefore 调整最终顺序。
  const nextNodeSet = new Set(nextNodes);

  [...container.childNodes].forEach((child) => {
    if (!nextNodeSet.has(child)) {
      container.removeChild(child);
    }
  });

  nextNodes.forEach((node) => {
    container.appendChild(node);
  });
};

// dom-host 静态条目同步时，需要避开 activeAnchor 本身，只处理其前方的有效展示节点。
export const syncDomHostStaticEntries = <TRenderable>(options: {
  container: HTMLElement;
  activeAnchor: Comment;
  rendered: readonly TRenderable[];
}): void => {
  const { container, activeAnchor, rendered } = options;
  const nextNodes: Node[] = rendered.flatMap((entry): Node[] => {
    if (entry instanceof Comment) {
      return [];
    }
    if (entry instanceof Node) {
      return [entry];
    }
    return [document.createTextNode(String(entry))];
  });
  const nextNodeSet = new Set(nextNodes);
  // 只同步 activeAnchor 之前、属于静态展示区间的节点，避免误碰后面的动态 active block。
  const activeNodes: ChildNode[] = [...container.childNodes].filter(
    (node) =>
      node !== activeAnchor &&
      (node.compareDocumentPosition(activeAnchor) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
        0
  );

  activeNodes.forEach((node) => {
    if (!nextNodeSet.has(node)) {
      container.removeChild(node);
    }
  });

  nextNodes.forEach((node) => {
    container.insertBefore(node, activeAnchor);
  });
};

// 组合当前/离场快照并产出最终 display。
// 若 stateKey 对应的容器已存在且 tag 一致，则优先复用现有容器。
export const renderSnapshotDisplay = <TRenderable>(options: {
  stateKey: string;
  transitionTag?: string;
  currentSnapshots: readonly TRenderable[];
  leavingSnapshots: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>;
}): TRenderable[] | HTMLElement => {
  const { stateKey, transitionTag, currentSnapshots, leavingSnapshots } =
    options;
  const display = buildGroupDisplay(currentSnapshots, leavingSnapshots);
  const current = getTransitionGroupState<TRenderable>(stateKey);

  // tag 未变化且已有容器时直接原位同步，避免每轮 commit 都重建包裹容器。
  if (transitionTag && current?.container && current.tag === transitionTag) {
    syncDisplayContainer(current.container, display);
    return current.container;
  }

  const wrapped = wrapDisplayWithTag(transitionTag, display);
  if (current && wrapped instanceof HTMLElement) {
    publishGroupState(stateKey, {
      ...current,
      container: wrapped,
      tag: transitionTag,
    });
  }

  return wrapped;
};

// 生成一个绑定了 stateKey/tag 的 display renderer，供上层 runtime 反复调用。
export const createSnapshotDisplayRenderer = <TRenderable>(options: {
  stateKey: string;
  transitionTag?: string;
}): ((input: {
  currentSnapshots: readonly TRenderable[];
  leavingSnapshots: Map<PropertyKey, GroupLeavingSnapshot<TRenderable>>;
}) => TRenderable[] | HTMLElement) => {
  const { stateKey, transitionTag } = options;
  return (input) =>
    renderSnapshotDisplay({
      stateKey,
      transitionTag,
      currentSnapshots: input.currentSnapshots,
      leavingSnapshots: input.leavingSnapshots,
    });
};
