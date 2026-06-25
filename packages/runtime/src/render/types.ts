/**
 * 渲染层公共类型定义。
 *
 * 这些类型横跨 DOM 挂载、hydration、SSR、teleport、Suspense patch 等多个阶段：
 * - `StaticTemplate` / `MountedStaticTemplate` 描述编译后静态模板及其实例；
 * - `Hydration*Record` 记录注释 marker 与真实 DOM 的对应关系；
 * - `SSRRenderContext` 聚合 SSR 期间需要跨组件共享的容器与异步块状态。
 */
import type { BoundaryPayload } from '@lania-v/shared';

export interface StaticTemplate {
  html: string;
  template: HTMLTemplateElement;
  clone(): DocumentFragment;
}

export interface HydrationSlotRecord {
  index: number;
  start: Comment;
  end: Comment;
  // start/end 之间当前保留的 DOM 节点快照，供 text/block/teleport 等 slot 复用。
  contentNodes: Node[];
  kind: string | null;
  metadata: unknown;
}

export interface HydrationBoundaryRecord {
  id: string;
  component: string;
  start: Comment;
  end: Comment;
  contentNodes: Node[];
  payload: BoundaryPayload | null;
  metadata: unknown;
}

export interface MountedStaticTemplate {
  // 记录模板实例最外层根节点，后续 path 解析与 hydration 都基于这组节点。
  nodes: Node[];
  hydrated: boolean;
  // 以 slotIndex 建索引，便于在 hydration 模式下直接定位注释包围区间。
  hydrationSlots: Map<number, HydrationSlotRecord>;
  hydrationBoundaries: HydrationBoundaryRecord[];
}

export interface MountStaticTemplateOptions {
  hydrate?: boolean;
}

export type SlotMarkerPosition = 'start' | 'end';

export interface ParsedSlotMarker {
  index: number;
  position: SlotMarkerPosition;
  kind: string | null;
  metadata: unknown;
}

export interface ParsedBoundaryMarker {
  id: string;
  position: SlotMarkerPosition;
  component: string;
  payload: BoundaryPayload | null;
  metadata: unknown;
}

export const SSR_RENDER_CONTEXT_KEY = '__laniaSSRContext';

export interface SSRTeleportContainerRecord {
  target: string;
  htmlParts: string[];
  slotIndices: number[];
}

export interface SSRSuspenseChunkRecord {
  boundaryId: string;
  slotIndex: number;
  html: string;
  metadata: unknown;
}

export interface SSRRenderContext {
  readonly teleportContainers: Map<string, SSRTeleportContainerRecord>;
  readonly suspenseChunks: SSRSuspenseChunkRecord[];
  // Promise 会先进入 pending 队列，drain 时统一收敛为可注入的 patch html。
  readonly pendingSuspenseChunks: Promise<SSRSuspenseChunkRecord>[];
  nextBoundaryId(): string;
  registerTeleport(target: string, slotIndex: number, html: string): void;
  registerSuspenseChunk(chunk: Promise<SSRSuspenseChunkRecord>): void;
}

export type SSRRenderScope = Record<string, unknown> & {
  [SSR_RENDER_CONTEXT_KEY]: SSRRenderContext;
};
