/**
 * DOM 模板挂载与 hydration 支持。
 *
 * - SSR/hydration 通过注释 marker（slot/boundary）在 DOM 中定位可复用节点；
 * - `mountStaticTemplate` 会在可 hydration 时复用已有 DOM，否则 clone template 插入；
 * - 解析 marker 的细节在 `markers.ts`，这里只做扫描与节点解析。
 *
 * 这个文件的核心目标是“把编译期静态模板与运行时真实 DOM 对上号”。
 * 在纯客户端挂载时，这个过程相对简单，只需 clone 模板并按路径取节点；
 * 但在 hydration 模式下，真实 DOM 中还会混入 SSR 注释 marker、Teleport 内容迁移、
 * Boundary 包裹节点等额外结构，因此必须提供一套“逻辑路径 -> 实际节点”的解析规则。
 *
 * 也就是说，这里维护的是“模板坐标系”和“真实 DOM 结构”之间的映射层。
 * 后续 slot 挂载、文本接管、boundary 接管都依赖这里给出的稳定节点定位结果。
 */
import {
  BOUNDARY_MARKER_PATTERN,
  TELEPORT_CONTAINER_PATTERN,
  parseBoundaryMarker,
  parseSlotMarker,
  collectCommentBoundedNodes,
} from './markers';
import type {
  HydrationBoundaryRecord,
  HydrationSlotRecord,
  MountedStaticTemplate,
  MountStaticTemplateOptions,
  StaticTemplate,
} from './types';

// 非 hydration 挂载占绝大多数，共享只读空集合可省掉每个模板实例两次分配。
const EMPTY_HYDRATION_SLOTS: ReadonlyMap<number, HydrationSlotRecord> = new Map();
const EMPTY_HYDRATION_BOUNDARIES: readonly HydrationBoundaryRecord[] = Object.freeze([]);

export const getEmptyHydrationSlots = (): ReadonlyMap<number, HydrationSlotRecord> => {
  return EMPTY_HYDRATION_SLOTS;
};

export const getEmptyHydrationBoundaries = (): readonly HydrationBoundaryRecord[] => {
  return EMPTY_HYDRATION_BOUNDARIES;
};

// 很多 hydration 判断都需要区分注释节点，因为 slot/boundary marker 都以注释形式存在。
const isCommentNode = (node: Node): node is Comment => {
  return node.nodeType === Node.COMMENT_NODE;
};

const scanHydrationSlotsFromComments = (
  comments: readonly Comment[]
): Map<number, HydrationSlotRecord> => {
  // slot marker 允许嵌套，因此同一 slotIndex 也使用“栈”来匹配 start/end。
  const stack = new Map<number, Comment[]>();
  const records = new Map<number, HydrationSlotRecord>();

  comments.forEach((comment) => {
    const marker = parseSlotMarker(comment.data);

    if (marker) {
      if (marker.position === 'start') {
        // 同一个 slotIndex 也可能因嵌套结构暂存多个 start，故按栈管理。
        const entries = stack.get(marker.index) ?? [];
        entries.push(comment);
        stack.set(marker.index, entries);
      } else {
        const starts = stack.get(marker.index);
        const start = starts?.pop();

        if (start) {
          if (starts && starts.length === 0) {
            stack.delete(marker.index);
          }

          const contentNodes: Node[] = [];
          let cursor = start.nextSibling;

          // start/end 之间的所有节点都视为这个 hydration slot 当前持有的内容。
          while (cursor && cursor !== comment) {
            contentNodes.push(cursor);
            cursor = cursor.nextSibling;
          }

          records.set(marker.index, {
            index: marker.index,
            start,
            end: comment,
            contentNodes,
            kind: marker.kind,
            metadata: marker.metadata,
          });
        }
      }
    }
  });

  return records;
};

const scanHydrationBoundariesFromComments = (
  comments: readonly Comment[]
): HydrationBoundaryRecord[] => {
  // Boundary 以字符串 id 配对，处理方式与 slot 类似，但记录的数据结构更偏边界语义。
  const stack = new Map<string, Comment[]>();
  const records: HydrationBoundaryRecord[] = [];

  comments.forEach((comment) => {
    const marker = parseBoundaryMarker(comment.data);

    if (marker) {
      if (marker.position === 'start') {
        const entries = stack.get(marker.id) ?? [];
        entries.push(comment);
        stack.set(marker.id, entries);
      } else {
        const starts = stack.get(marker.id);
        const start = starts?.pop();

        if (start) {
          if (starts && starts.length === 0) {
            stack.delete(marker.id);
          }

          const contentNodes: Node[] = [];
          let cursor = start.nextSibling;

          while (cursor && cursor !== comment) {
            contentNodes.push(cursor);
            cursor = cursor.nextSibling;
          }

          records.push({
            id: marker.id,
            component: marker.component,
            start,
            end: comment,
            contentNodes,
            payload: marker.payload,
            metadata: marker.metadata,
          });
        }
      }
    }
  });

  return records;
};

const collectHydrationCommentsFromRoot = (root: Node): Comment[] => {
  // 从整棵 DOM 子树中平铺收集 comment，后续 slot/boundary 扫描都复用这份结果。
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const comments: Comment[] = [];
  let current = walker.nextNode();

  while (current) {
    comments.push(current as Comment);
    current = walker.nextNode();
  }

  return comments;
};

const collectHydrationCommentsFromNodes = (nodes: readonly Node[]): Comment[] => {
  const comments: Comment[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === Node.COMMENT_NODE) {
      comments.push(node as Comment);
    }
    // 这里显式递归而不是依赖 TreeWalker，是因为输入是一组离散根节点。
    node.childNodes.forEach((child) => {
      visit(child);
    });
  };

  nodes.forEach((node) => {
    visit(node);
  });

  return comments;
};

const hasHydrationMarkers = (root: Node): boolean => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  let current = walker.nextNode();

  while (current) {
    const comment = current as Comment;

    // 只要存在任一 start marker，就说明当前 DOM 很可能来自 SSR，可尝试走 hydration。
    if (
      parseSlotMarker(comment.data)?.position === 'start' ||
      parseBoundaryMarker(comment.data)?.position === 'start'
    ) {
      return true;
    }

    current = walker.nextNode();
  }

  return false;
};

const getLogicalChildNode = (
  children: readonly Node[],
  logicalIndex: number,
  hydrationSlots: ReadonlyMap<number, HydrationSlotRecord>
): Node => {
  // `logicalIndex` 指的是“模板视角下的第 N 个孩子”，不是物理 childNodes 下标。
  // comment marker 虽然真实存在于 DOM 中，但在模板坐标系里并不总算一个可见子节点。
  let cursor = 0;
  let logicalCursor = 0;

  while (cursor < children.length) {
    const candidate = children[cursor]!;

    if (isCommentNode(candidate)) {
      const boundaryMarker = parseBoundaryMarker(candidate.data);

      if (boundaryMarker) {
        cursor += 1;
        continue;
      }

      const marker = parseSlotMarker(candidate.data);
      const record = marker ? hydrationSlots.get(marker.index) : undefined;

      if (marker?.position === 'start' && record?.start === candidate) {
        if (logicalCursor === logicalIndex) {
          // slot 在模板结构里占一个逻辑位置，但其实际锚点是 end comment。
          // 这样后续 block slot 接管时可以直接拿到稳定锚点，而不是 slot 内容中的任意一个节点。
          return record.end;
        }

        const endIndex = children.indexOf(record.end);

        if (endIndex === -1) {
          throw new Error(`Hydration end marker for slot ${record.index} was not found.`);
        }

        logicalCursor += 1;
        cursor = endIndex + 1;
        continue;
      }

      if (marker?.position === 'end' && record?.end === candidate) {
        cursor += 1;
        continue;
      }
    }

    if (logicalCursor === logicalIndex) {
      return candidate;
    }

    logicalCursor += 1;
    cursor += 1;
  }

  throw new Error(`Template logical child at index ${logicalIndex} was not found.`);
};

const ensureHydratedTextNode = (record: HydrationSlotRecord): Text => {
  const existingTextNode = record.contentNodes.find((node): node is Text => {
    return node.nodeType === Node.TEXT_NODE;
  });

  if (existingTextNode) {
    return existingTextNode;
  }

  const textNode = document.createTextNode('');
  // SSR 可能输出了空内容，导致 marker 之间没有真实 Text；这里补一个供 TextSlot 接管。
  record.end.parentNode?.insertBefore(textNode, record.end);
  record.contentNodes = [textNode];
  return textNode;
};

const getRootNodes = (root: Node): Node[] => {
  return [...root.childNodes];
};

export const createStaticTemplate = (html: string): StaticTemplate => {
  const template = document.createElement('template');
  template.innerHTML = html;

  // 编译器会把动态文本槽位先输出成 `__LANIA_SLOT_N__` 占位文本。
  // 这里提前把占位符拆成真实 Text 节点，避免初始化前占位串暴露到页面，
  // 同时保证后续 path 解析仍能和编译期 DOM 结构一一对应。
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const placeholder = /__LANIA_SLOT_\d+__/g;
  const textNodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    textNodes.push(current as Text);
    current = walker.nextNode();
  }

  for (const text of textNodes) {
    const parent = text.parentNode;

    if (!parent) {
      continue;
    }

    placeholder.lastIndex = 0;

    if (!placeholder.test(text.data)) {
      continue;
    }

    // 把一个带占位符的单个 Text 节点拆成多个真实 Text 节点，
    // 这样后续 path / slotIndex 才能稳定定位到独立文本槽位。
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    placeholder.lastIndex = 0;

    for (const match of text.data.matchAll(placeholder)) {
      const matchIndex = match.index ?? 0;

      if (matchIndex > cursor) {
        fragment.append(document.createTextNode(text.data.slice(cursor, matchIndex)));
      }

      fragment.append(document.createTextNode(''));
      cursor = matchIndex + match[0].length;
    }

    if (cursor < text.data.length) {
      fragment.append(document.createTextNode(text.data.slice(cursor)));
    }

    parent.insertBefore(fragment, text);
    parent.removeChild(text);
  }

  return {
    html,
    template,
    clone() {
      return template.content.cloneNode(true) as DocumentFragment;
    },
  };
};

export const mountStaticTemplate = (
  root: Node,
  staticTemplate: StaticTemplate,
  options: MountStaticTemplateOptions = {}
): MountedStaticTemplate => {
  // 只在调用方未显式关闭 hydrate、且 root 已带 SSR 注释 marker 时复用现有 DOM。
  // 这一步不会验证 DOM 是否和模板完全一致；真正的细粒度对齐发生在后续路径/slot 解析阶段。
  if (options.hydrate !== false && root.childNodes.length > 0 && hasHydrationMarkers(root)) {
    const nodes = getRootNodes(root);
    const comments = collectHydrationCommentsFromRoot(root);
    return {
      nodes,
      hydrated: true,
      hydrationSlots: scanHydrationSlotsFromComments(comments),
      hydrationBoundaries: scanHydrationBoundariesFromComments(comments),
    };
  }

  // 非 hydration 场景直接 clone 静态模板并挂进 root，后续路径解析走纯客户端模式。
  const fragment = staticTemplate.clone();
  const nodes = [...fragment.childNodes];

  root.appendChild(fragment);

  return {
    nodes,
    hydrated: false,
    hydrationSlots: EMPTY_HYDRATION_SLOTS,
    hydrationBoundaries: EMPTY_HYDRATION_BOUNDARIES,
  };
};

export const createHydratedTemplate = (
  nodes: readonly Node[]
): MountedStaticTemplate => {
  // 某些运行时流程已经拿到一批现成节点，这里把它们包装成“已 hydration”的模板记录。
  const retainedNodes = [...nodes];
  const comments = collectHydrationCommentsFromNodes(retainedNodes);

  return {
    nodes: retainedNodes,
    hydrated: true,
    hydrationSlots: scanHydrationSlotsFromComments(comments),
    hydrationBoundaries: scanHydrationBoundariesFromComments(comments),
  };
};

export const resolveTemplateNode = (
  nodes: readonly Node[],
  path: readonly number[]
): Node => {
  if (path.length === 0) {
    throw new Error('Template node path must not be empty.');
  }

  let current = nodes[path[0]];

  if (!current) {
    throw new Error(`Template root node at index ${path[0]} was not found.`);
  }

  for (let index = 1; index < path.length; index += 1) {
    // 非 hydration 模式下可以直接按物理 childNodes 下标逐层下钻。
    current = current.childNodes[path[index]!];

    if (!current) {
      throw new Error(`Template node path "${path.join('.')}" was not found.`);
    }
  }

  return current;
};

export const resolveMountedTemplateNode = (
  mounted: MountedStaticTemplate,
  path: readonly number[]
): Node => {
  if (!mounted.hydrated) {
    // 纯客户端模式无需特殊处理，直接沿模板物理路径解析。
    return resolveTemplateNode(mounted.nodes, path);
  }

  if (path.length === 0) {
    throw new Error('Template node path must not be empty.');
  }

  // hydration 模式下不能直接按物理 childNodes 下标取节点，因为注释 marker 也占位。
  // 这里始终沿“逻辑路径”下钻，保证编译期 path 在 SSR / CSR 两条路径下都复用同一套坐标。
  let current = getLogicalChildNode(mounted.nodes, path[0]!, mounted.hydrationSlots);

  for (const index of path.slice(1)) {
    // 进入子树后仍要继续按“逻辑子节点”而非真实 childNodes 遍历。
    current = getLogicalChildNode([...current.childNodes], index, mounted.hydrationSlots);
  }

  return current;
};

const ensureTextSlotNode = (
  mounted: MountedStaticTemplate,
  path: readonly number[]
): Text => {
  if (path.length === 0) {
    throw new Error('Template node path must not be empty.');
  }

  if (path.length === 1) {
    const existing = mounted.nodes[path[0]];
    if (existing instanceof Text) {
      return existing;
    }
    // 根层级文本槽缺失时，直接在对应位置前插入一个空 Text 节点兜底。
    const textNode = document.createTextNode('');
    const beforeNode = mounted.nodes[path[0]] ?? null;
    const parent = beforeNode?.parentNode;
    if (parent) {
      parent.insertBefore(textNode, beforeNode);
    }
    mounted.nodes.splice(path[0], 0, textNode);
    return textNode;
  }

  const parentPath = path.slice(0, -1);
  const childIndex = path[path.length - 1]!;
  const parentNode = resolveTemplateNode(mounted.nodes, parentPath);
  const existing = parentNode.childNodes[childIndex];
  if (existing instanceof Text) {
    return existing;
  }

  // 非根层级的补建逻辑与上面一致，只是插入位置变为父节点的某个子索引。
  const textNode = document.createTextNode('');
  const beforeNode = parentNode.childNodes[childIndex] ?? null;
  parentNode.insertBefore(textNode, beforeNode);
  return textNode;
};

export const resolveTextSlotNode = (
  mounted: MountedStaticTemplate,
  slotIndex: number,
  path: readonly number[]
): Text => {
  const hydratedRecord = mounted.hydrationSlots.get(slotIndex);

  if (mounted.hydrated && hydratedRecord) {
    // hydration 优先接管 SSR 已留下的内容，没有文本节点时再最小化补建。
    // 这样既能复用已有文本节点，也能兼容 SSR 输出空串时 marker 之间没有真实 Text 的场景。
    return ensureHydratedTextNode(hydratedRecord);
  }

  try {
    return resolveMountedTemplateNode(mounted, path) as Text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Template node path')) {
      throw error;
    }
    // 对于原本由占位文本演化而来的路径，缺失时允许补建 Text 节点兜底。
    return ensureTextSlotNode(mounted, path);
  }
};

export const resolveSlotAnchor = (
  mounted: MountedStaticTemplate,
  slotIndex: number,
  path: readonly number[]
): Comment => {
  const hydratedRecord = mounted.hydrationSlots.get(slotIndex);

  if (mounted.hydrated && hydratedRecord) {
    // hydration 模式下 block slot 的真实锚点来自 SSR end marker。
    return hydratedRecord.end;
  }

  return resolveMountedTemplateNode(mounted, path) as Comment;
};

export const readHydrationSlotNodes = (
  mounted: MountedStaticTemplate,
  slotIndex: number
): Node[] => {
  // 返回拷贝，避免外部直接修改内部 record 持有的数组。
  return [...(mounted.hydrationSlots.get(slotIndex)?.contentNodes ?? [])];
};

export const hasHydrationSlot = (
  mounted: MountedStaticTemplate,
  slotIndex: number
): boolean => {
  return mounted.hydrationSlots.has(slotIndex);
};

export const readHydrationBoundaries = (
  mounted: MountedStaticTemplate,
  component?: string
): HydrationBoundaryRecord[] => {
  if (!component) {
    // 默认返回全部 boundary 记录，调用方可自行按组件维度再过滤。
    return [...mounted.hydrationBoundaries];
  }

  return mounted.hydrationBoundaries.filter((record) => record.component === component);
};

const resolveTeleportTarget = (value: unknown): Element | null => {
  // Teleport 目标既允许直接传 Element，也允许传 CSS 选择器字符串。
  if (value instanceof Element) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return document.querySelector(value);
  }

  return null;
};

export const readTeleportNodes = (
  mounted: MountedStaticTemplate,
  slotIndex: number,
  target: unknown
): Node[] => {
  if (!mounted.hydrated) {
    // 非 hydration 场景不存在需要“读回”的 teleport SSR 内容。
    return [];
  }

  const resolvedTarget = resolveTeleportTarget(target);

  if (!resolvedTarget) {
    return [];
  }

  // teleport 内容实际被安置在目标容器上，需要去目标节点中重新扫描 marker。
  const records = collectCommentBoundedNodes(resolvedTarget, TELEPORT_CONTAINER_PATTERN);
  const match = records.find((record) => Number(record.id) === slotIndex);

  if (!match) {
    return [];
  }

  const contentNodes: Node[] = [];
  let cursor = match.start.nextSibling;

  // 读取 teleport 容器中同一 slot 对应的区间节点，交给 TeleportSlot 继续接管。
  while (cursor && cursor !== match.end) {
    contentNodes.push(cursor);
    cursor = cursor.nextSibling;
  }

  return contentNodes;
};

// 保留旧公开名称，兼容仍引用旧标识符的编译产物。
export const readHydrationTeleportSlotNodes = readTeleportNodes;

export const readBoundaryComments = (root: Node) => {
  return collectCommentBoundedNodes(root, BOUNDARY_MARKER_PATTERN);
};
