/**
 * 提供增强组件渲染值的归一化与节点提取工具。
 *
 * 这些工具会把函数、数组、Fragment 与文本统一拍平成运行时可操作的节点集合，
 * 供 Dynamic、Slot、TransitionGroup 等场景复用。
 */
import type { EnhancedRenderable } from '../types';

// 惰性 renderable 会在真正消费前执行，普通值则原样返回。
export const invokeRenderable = (value: EnhancedRenderable): EnhancedRenderable => {
  return typeof value === 'function'
    ? (value as () => EnhancedRenderable)()
    : value;
};

export const asRenderable = (value: unknown): EnhancedRenderable => {
  return value as EnhancedRenderable;
};

// 深度拍平数组和函数结果，忽略 null/false，得到稳定的一维 renderable 列表。
export const toRenderableArray = (value: EnhancedRenderable): EnhancedRenderable[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => toRenderableArray(entry));
  }

  if (typeof value === 'function') {
    return toRenderableArray((value as () => EnhancedRenderable)());
  }

  if (value == null || value === false) {
    return [];
  }

  return [value];
};

export const getRenderableElements = (value: EnhancedRenderable): Element[] => {
  return toRenderableArray(value).flatMap((entry) => {
    if (entry instanceof Element) {
      return [entry];
    }

    if (entry instanceof DocumentFragment) {
      return [...entry.childNodes].filter(
        (child): child is Element => child instanceof Element
      );
    }

    return [];
  });
};

// 注释节点不算可见内容，Fragment 需要继续递归其子节点。
const hasNodeContent = (node: Node): boolean => {
  if (node instanceof Comment) {
    return false;
  }

  if (node instanceof Text) {
    return node.data.length > 0;
  }

  if (node instanceof DocumentFragment) {
    return [...node.childNodes].some((child) =>
      hasNodeContent(child)
    );
  }

  return true;
};

export const hasRenderableContent = (value: EnhancedRenderable): boolean => {
  return toRenderableArray(value).some((entry) => {
    if (entry == null || entry === false) {
      return false;
    }

    if (entry instanceof Node) {
      return hasNodeContent(entry);
    }

    return String(entry).length > 0;
  });
};

// 把统一后的 renderable 追加到宿主节点，非 Node 值会转成文本节点。
export const appendRenderable = (host: Node, value: EnhancedRenderable): void => {
  toRenderableArray(value).forEach((entry) => {
    if (entry instanceof Node) {
      host.appendChild(entry);
      return;
    }

    host.appendChild(document.createTextNode(String(entry)));
  });
};

export const createValueFromNodes = (
  nodes: readonly Node[]
): EnhancedRenderable => {
  if (nodes.length === 0) {
    return null;
  }

  if (nodes.length === 1) {
    return nodes[0]!;
  }

  return [...nodes];
};

// 收集真实节点快照，供缓存、过渡和 host 同步逻辑直接消费。
export const collectRenderableNodes = (value: EnhancedRenderable): Node[] => {
  const parts: Node[] = [];

  const push = (entry: EnhancedRenderable): void => {
    if (entry == null || entry === false) {
      return;
    }

    const resolved = invokeRenderable(entry);

    if (Array.isArray(resolved)) {
      resolved.forEach((child) => push(child));
      return;
    }

    if (resolved instanceof Node) {
      parts.push(resolved);
      return;
    }

    parts.push(document.createTextNode(String(resolved)));
  };

  push(value);
  return parts;
};

export const resolveRenderableIdentity = (
  value: EnhancedRenderable
): string | null => {
  const [first] = toRenderableArray(value);

  if (!first) {
    return null;
  }

  if (first instanceof Element) {
    return (
      first.getAttribute('data-key') ?? first.id ?? first.tagName.toLowerCase()
    );
  }

  if (typeof first === 'string' || typeof first === 'number') {
    return String(first);
  }

  return null;
};
