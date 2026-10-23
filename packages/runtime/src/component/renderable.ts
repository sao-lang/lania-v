/**
 * 渲染值归一化工具（renderable helpers）。
 *
 * 这些函数把函数、数组、Fragment 与文本统一拍平成可操作的节点集合，
 * host 与 slot 层内部依赖它们；`@lania-v/runtime/advanced` 也会复用同一份实现。
 */
export interface RenderableValue {
  readonly [key: string]: unknown;
}

export type Renderable = unknown;

// 惰性 renderable 会在真正消费前执行，普通值则原样返回。
export const invokeRenderable = (value: Renderable): Renderable => {
  return typeof value === 'function' ? (value as () => Renderable)() : value;
};

export const asRenderable = (value: unknown): Renderable => value;

// 深度拍平数组和函数结果，忽略 null/false，得到稳定的一维列表。
export const toRenderableArray = (value: Renderable): Renderable[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => toRenderableArray(entry));
  }

  if (typeof value === 'function') {
    return toRenderableArray((value as () => Renderable)());
  }

  if (value == null || value === false) {
    return [];
  }

  return [value];
};

export const getRenderableElements = (value: Renderable): Element[] => {
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
    return [...node.childNodes].some((child) => hasNodeContent(child));
  }

  return true;
};

export const hasRenderableContent = (value: Renderable): boolean => {
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

// 把统一后的值追加到宿主节点，非 Node 值会转成文本节点。
export const appendRenderable = (host: Node, value: Renderable): void => {
  toRenderableArray(value).forEach((entry) => {
    if (entry instanceof Node) {
      host.appendChild(entry);
      return;
    }

    host.appendChild(document.createTextNode(String(entry)));
  });
};

export const createValueFromNodes = (nodes: readonly Node[]): Renderable => {
  if (nodes.length === 0) {
    return null;
  }

  if (nodes.length === 1) {
    return nodes[0]!;
  }

  return [...nodes];
};

// 收集真实节点快照，供缓存、过渡和 host 同步逻辑直接消费。
export const collectRenderableNodes = (value: Renderable): Node[] => {
  const parts: Node[] = [];

  const push = (entry: Renderable): void => {
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

export const resolveRenderableIdentity = (value: Renderable): string | null => {
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
