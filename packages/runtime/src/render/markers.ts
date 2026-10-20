/**
 * SSR / hydration 注释 marker 的编解码工具。
 *
 * 运行时通过注释节点把“编译期 slot / boundary 信息”嵌入到 DOM 中，再在 hydration
 * 阶段把这些注释重新解析回结构化记录。这里的职责包括：
 * - 定义不同 marker 的匹配规则；
 * - 负责 metadata 的序列化、反序列化；
 * - 按 start/end 注释成对收集区间节点，供 teleport、Suspense、boundary 复用。
 */
import type {
  ParsedBoundaryMarker,
  ParsedSlotMarker,
  SlotMarkerPosition,
} from './types';
import { isBoundaryPayload, type BoundaryPayload } from '@lania-v/shared';

export const SLOT_MARKER_PATTERN = /^__LANIA_SLOT_(\d+)_(START|END)__(?::([\s\S]+))?$/;
// 编译期块锚点：`<!--__LANIA_SLOT_N__-->`，仅用于客户端首次挂载时定位块位置。
export const BLOCK_ANCHOR_PATTERN = /^__LANIA_SLOT_\d+__$/;
export const BOUNDARY_MARKER_PATTERN = /^__LANIA_BOUNDARY_([^_]+)_(START|END)__(?::([^:]+)(?::([\s\S]+))?)?$/;
export const TELEPORT_CONTAINER_PATTERN = /^__LANIA_TELEPORT_CONTAINER_(\d+)_(START|END)__(?::([\s\S]+))?$/;
export const SUSPENSE_PATCH_PATTERN = /^__LANIA_SUSPENSE_PATCH_([^_]+)_(START|END)__(?::([\s\S]+))?$/;

export const decodeSlotMeta = (value: string | undefined): unknown => {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(decodeURIComponent(value));
  } catch {
    return value;
  }
};

export const parseSlotMarker = (value: string | null): ParsedSlotMarker | null => {
  if (!value) {
    return null;
  }

  const match = SLOT_MARKER_PATTERN.exec(value.trim());

  if (!match) {
    return null;
  }

  // payload 兼容两种格式：
  // 1. `kind`
  // 2. `kind:encodedMetadata`
  const payload = match[3]?.trim() ?? '';
  const firstSeparator = payload.indexOf(':');
  const kind =
    payload.length === 0
      ? null
      : firstSeparator === -1
        ? payload
        : payload.slice(0, firstSeparator);
  const metadata =
    firstSeparator === -1 ? null : decodeSlotMeta(payload.slice(firstSeparator + 1));

  return {
    index: Number(match[1]),
    position: match[2] === 'START' ? 'start' : 'end',
    kind,
    metadata,
  };
};

export const parseBoundaryMarker = (value: string | null): ParsedBoundaryMarker | null => {
  if (!value) {
    return null;
  }

  const match = BOUNDARY_MARKER_PATTERN.exec(value.trim());

  if (!match || !match[3]) {
    return null;
  }

  // boundary 优先按共享层定义的 BoundaryPayload 解码，失败时再退回普通 metadata。
  const decodedPayload = decodeSlotMeta(match[4]);
  const payload = isBoundaryPayload(decodedPayload)
    ? (decodedPayload as BoundaryPayload)
    : null;

  return {
    id: match[1]!,
    position: match[2] === 'START' ? 'start' : 'end',
    component: payload?.component ?? match[3],
    payload,
    metadata: payload?.metadata ?? decodedPayload,
  };
};

export const serializeMarkerPayload = (kind: string, metadata: unknown): string => {
  return metadata === undefined
    ? kind
    : `${kind}:${encodeURIComponent(JSON.stringify(metadata))}`;
};

export const serializeBoundaryPayload = (component: string, metadata: unknown): string => {
  return metadata === undefined
    ? component
    : `${component}:${encodeURIComponent(JSON.stringify(metadata))}`;
};

export const renderBoundaryMarker = (
  id: string,
  position: SlotMarkerPosition,
  component: string,
  metadata?: unknown
): string => {
  const payload = serializeBoundaryPayload(component, metadata);
  return `<!--__LANIA_BOUNDARY_${id}_${position === 'start' ? 'START' : 'END'}__:${payload}-->`;
};

export const renderTeleportContainerMarker = (
  slotIndex: number,
  position: SlotMarkerPosition,
  metadata?: unknown
): string => {
  const payload =
    metadata === undefined ? '' : `:${encodeURIComponent(JSON.stringify(metadata))}`;
  return `<!--__LANIA_TELEPORT_CONTAINER_${slotIndex}_${position === 'start' ? 'START' : 'END'}__${payload}-->`;
};

export const renderSuspensePatchMarker = (
  boundaryId: string,
  position: SlotMarkerPosition,
  metadata?: unknown
): string => {
  const payload =
    metadata === undefined ? '' : `:${encodeURIComponent(JSON.stringify(metadata))}`;
  return `<!--__LANIA_SUSPENSE_PATCH_${boundaryId}_${position === 'start' ? 'START' : 'END'}__${payload}-->`;
};

export const collectCommentBoundedNodes = (
  root: Node,
  pattern: RegExp
): Array<{
  id: string;
  start: Comment;
  end: Comment;
  metadata: unknown;
}> => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const starts = new Map<string, Comment[]>();
  const records: Array<{
    id: string;
    start: Comment;
    end: Comment;
    metadata: unknown;
  }> = [];
  let current = walker.nextNode();

  while (current) {
    const comment = current as Comment;
    const match = pattern.exec(comment.data.trim());

    if (match) {
      const id = match[1]!;
      const position = match[2] === 'START' ? 'start' : 'end';
      const metadata = decodeSlotMeta(match[3]);

      if (position === 'start') {
        // 允许同 id 嵌套，故这里按栈处理而不是只保留单个 start。
        const bucket = starts.get(id) ?? [];
        bucket.push(comment);
        starts.set(id, bucket);
      } else {
        const bucket = starts.get(id);
        const start = bucket?.pop();

        if (start) {
          if (bucket && bucket.length === 0) {
            starts.delete(id);
          }

          records.push({
            id,
            start,
            end: comment,
            metadata,
          });
        }
      }
    }

    current = walker.nextNode();
  }

  return records;
};
