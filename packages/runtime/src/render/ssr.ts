/**
 * SSR 渲染辅助实现。
 *
 * 这个文件负责把运行时里的 slot / boundary / teleport / suspense 语义投影成服务端 HTML：
 * - 通过注释 marker 标出 block、boundary、teleport container 等动态区间，供 hydration 重新接管；
 * - 通过一套最小 DOM 挂载流程复用模板绑定解析逻辑，尽量保持 SSR 与 CSR 的节点路径语义一致；
 * - 通过 render context 收集 teleport 容器内容与 suspense patch，支持主流内容与异步补丁分阶段输出。
 * - 通过 metadata/payload 把运行时补充信息编码进注释节点，为客户端局部恢复提供定位线索。
 *
 * 它既是字符串渲染层，也是 hydration 协议的一部分，因此 marker 与 metadata 的写法需要保持稳定。
 *
 * 可以把内部逻辑分成四层：
 * - 基础转义与属性序列化；
 * - slot/boundary 的 HTML 包装；
 * - teleport / suspense 的上下文收集；
 * - 客户端收到异步 patch 后的局部回填。
 */
import {
  SUSPENSE_PATCH_PATTERN,
  collectCommentBoundedNodes,
  parseBoundaryMarker,
  renderBoundaryMarker,
  renderSuspensePatchMarker,
  renderTeleportContainerMarker,
  serializeMarkerPayload,
} from './markers';
import {
  mountStaticTemplate,
  readBoundaryComments,
  resolveMountedTemplateNode,
  resolveTextSlotNode,
} from './dom';
import { normalizeClassValue, writeClassAttribute } from '../dom/class-value';
import { resolveHtmlBindingText } from '../dom/html-value';
import { normalizeStyleValue, writeStyleAttribute } from '../dom/style-value';
import {
  SSR_RENDER_CONTEXT_KEY,
  type MountedStaticTemplate,
  type SSRRenderContext,
  type SSRRenderScope,
  type SSRSuspenseChunkRecord,
  type SSRTeleportContainerRecord,
  type StaticTemplate,
} from './types';
import { isEnhancedBlockPayload } from '@lania-v/shared';

export interface SSRComponentLike {
  render?: (props?: Record<string, unknown>) => string;
  renderStream?: (
    props?: Record<string, unknown>
  ) => AsyncGenerator<string, void, void>;
}

/**
 * 调用编译产物上的 `static render()` 输出 HTML。
 *
 * 这是 SSR 的最小公开入口：编译期已经把模板与 slot marker 生成好，
 * 服务端只需要提供 props 上下文。
 */
export const renderToString = (
  component: SSRComponentLike,
  props: Record<string, unknown> = {}
): string => {
  if (typeof component.render !== 'function') {
    throw new TypeError(
      'renderToString() expects a compiled component with a static render() method.'
    );
  }

  return component.render(props);
};

/** 调用编译产物上的 `static renderStream()` 输出异步 HTML 片段。 */
export const renderToStream = (
  component: SSRComponentLike,
  props: Record<string, unknown> = {}
): AsyncGenerator<string, void, void> => {
  if (typeof component.renderStream !== 'function') {
    throw new TypeError(
      'renderToStream() expects a compiled component with a static renderStream() method.'
    );
  }

  return component.renderStream(props);
};

const escapeHtml = (value: string): string => {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
};

export const ssrEscapeHtml = (value: unknown): string => {
  return escapeHtml(value == null ? '' : String(value));
};

export const ssrSerializeAttribute = (name: string, value: unknown): string => {
  if (value == null || value === false) {
    return '';
  }

  if (value === true) {
    // 布尔属性在 SSR 中按 HTML 约定仅输出属性名本身。
    return ` ${name}`;
  }

  if (name === 'class') {
    const normalized = normalizeClassValue(value);
    return normalized.length > 0 ? ` class="${escapeHtml(normalized)}"` : '';
  }

  if (name === 'style') {
    const normalized = normalizeStyleValue(value);
    return normalized.length > 0 ? ` style="${escapeHtml(normalized)}"` : '';
  }

  return ` ${name}="${escapeHtml(String(value))}"`;
};

const ssrNormalizeOutput = (value: unknown): string => {
  if (value == null || value === false) {
    return '';
  }

  if (Array.isArray(value)) {
    // SSR 输出允许嵌套数组，统一拍平为字符串片段。
    return value.map((entry) => ssrNormalizeOutput(entry)).join('');
  }

  return typeof value === 'string' ? value : ssrEscapeHtml(value);
};

type SSRSlotListBinding = {
  kind: string;
  slotIndex: number;
  path: readonly number[];
  name?: string;
  unit?: string;
  evaluate?: (...args: unknown[]) => unknown;
};

type SSRForPayload =
  | {
      __lania_for: 'slots' | 'keyed-slots';
      items: unknown;
      template: StaticTemplate;
      bindings: readonly SSRSlotListBinding[];
    }
  | {
      __lania_for: 'keyed';
      items: unknown;
      render: (item: unknown, index: number) => unknown;
      key?: (item: unknown, index: number) => unknown;
    };

const isSSRForPayload = (value: unknown): value is SSRForPayload => {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__lania_for' in value &&
    typeof (value as { __lania_for?: unknown }).__lania_for === 'string'
  );
};

const renderSSRTemplateHtml = (
  template: StaticTemplate,
  bindings: readonly SSRSlotListBinding[],
  ...args: unknown[]
): string => {
  const host = document.createElement('div');
  // SSR 这里故意借一层真实 DOM 容器执行模板绑定，换取与 CSR 一致的节点定位规则。
  const mounted = mountStaticTemplate(host, template) as MountedStaticTemplate;
  bindings.forEach((binding) => {
    const evaluate = binding.evaluate;
    if (typeof evaluate !== 'function') {
      return;
    }

    switch (binding.kind) {
      case 'text': {
        // 复用 DOM 渲染层的节点解析逻辑，避免 SSR 与 CSR 在路径含义上分叉。
        const node = resolveTextSlotNode(mounted, binding.slotIndex, binding.path);
        node.data = ssrEscapeHtml(evaluate(...args));
        return;
      }
      case 'attr': {
        const node = resolveMountedTemplateNode(mounted, binding.path);
        if (!(node instanceof Element) || !binding.name) {
          return;
        }
        const nextValue = evaluate(...args);
        // `attr` 分支保留“属性语义”，不会像 prop 分支那样尝试模拟浏览器运行时 property 行为。
        if (binding.name === 'class') {
          writeClassAttribute(node, nextValue, node.getAttribute('class') ?? '');
        } else if (binding.name === 'style') {
          writeStyleAttribute(node, nextValue, node.getAttribute('style') ?? '');
        } else if (nextValue == null || nextValue === false) {
          node.removeAttribute(binding.name);
        } else {
          node.setAttribute(binding.name, String(nextValue));
        }
        return;
      }
      case 'class': {
        const node = resolveMountedTemplateNode(mounted, binding.path);
        if (!(node instanceof Element) || !binding.name) {
          return;
        }
        node.classList.toggle(binding.name, Boolean(evaluate(...args)));
        return;
      }
      case 'style': {
        const node = resolveMountedTemplateNode(mounted, binding.path);
        if (!(node instanceof HTMLElement) || !binding.name) {
          return;
        }
        const nextValue = evaluate(...args);
        const suffix = binding.unit ?? '';
        node.style.setProperty(binding.name, nextValue == null ? '' : `${String(nextValue)}${suffix}`);
        return;
      }
      case 'prop': {
        const node = resolveMountedTemplateNode(mounted, binding.path);
        if (!(node instanceof HTMLElement) || !binding.name) {
          return;
        }
        const nextValue = evaluate(...args);
        // prop 序列化只覆盖对 HTML 首屏有意义的少数属性，避免伪造浏览器完整 property 副作用。
        if (binding.name === 'value') {
          node.setAttribute('value', nextValue == null ? '' : String(nextValue));
        } else if (binding.name === 'checked' || binding.name === 'selected') {
          if (nextValue) {
            node.setAttribute(binding.name, '');
          } else {
            node.removeAttribute(binding.name);
          }
        }
        return;
      }
      default:
        return;
    }
  });
  return host.innerHTML;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const mergeBoundaryMeta = (
  payloadOrMetadata: unknown,
  metadataPatch: Record<string, unknown>
): unknown => {
  if (isEnhancedBlockPayload(payloadOrMetadata)) {
    const baseMetadata = isRecord(payloadOrMetadata.metadata) ? payloadOrMetadata.metadata : {};

    return {
      ...payloadOrMetadata,
      metadata: {
        ...baseMetadata,
        ...metadataPatch,
      },
    };
  }

  return {
    ...(isRecord(payloadOrMetadata) ? payloadOrMetadata : {}),
    ...metadataPatch,
  };
};

export const ssrRenderBlockSlot = (
  slotIndex: number,
  value: unknown,
  kind = 'block',
  metadata?: unknown
): string => {
  // start/end marker 成对出现，hydration 依赖它们来恢复当前 slot 的边界。
  const payload = serializeMarkerPayload(kind, metadata);
  return `<!--__LANIA_SLOT_${slotIndex}_START__:${payload}-->${ssrNormalizeOutput(value)}<!--__LANIA_SLOT_${slotIndex}_END__:${payload}-->`;
};

export const ssrRenderForSlot = (
  slotIndex: number,
  value: unknown,
  fallback = ''
): string => {
  if (isSSRForPayload(value)) {
    if (value.__lania_for === 'keyed') {
      const items = Array.isArray(value.items) ? value.items : [];
      // 这种 keyed payload 直接复用调用方提供的 render 函数，不再走静态模板挂载桥。
      const html =
        items.length > 0
          ? items.map((item, index) => ssrNormalizeOutput(value.render(item, index))).join('')
          : fallback;
      return ssrRenderBlockSlot(slotIndex, html, 'for');
    }

    const items = Array.isArray(value.items) ? value.items : [];
    const html =
      items.length > 0
        ? items
            .map((item, index) => {
              const rendered = renderSSRTemplateHtml(value.template, value.bindings, item, index);
              // keyed-slots 需要给每个条目再包一层 for marker，便于 hydration 区分条目边界。
              return value.__lania_for === 'keyed-slots'
                ? `<!--lania-for:start-->${rendered}<!--lania-for:end-->`
                : rendered;
            })
            .join('')
        : fallback;
    return ssrRenderBlockSlot(slotIndex, html, 'for');
  }

  const html = Array.isArray(value) ? value.map((entry) => ssrNormalizeOutput(entry)).join('') : ssrNormalizeOutput(value);
  return ssrRenderBlockSlot(slotIndex, html || fallback, 'for');
};

export const ssrRenderTextSlot = (slotIndex: number, value: unknown): string => {
  return ssrRenderBlockSlot(slotIndex, ssrEscapeHtml(value), 'text');
};

export const ssrRenderHtmlSlot = (slotIndex: number, value: unknown): string => {
  void slotIndex;
  return resolveHtmlBindingText(value);
};

export const ssrRenderEnhancedBoundary = (
  boundaryId: string,
  component: string,
  value: unknown,
  metadata?: unknown
): string => {
  // Enhanced boundary 的外层 marker 既服务 SSR 输出，也服务客户端 hydration 时的区间识别。
  return `${renderBoundaryMarker(boundaryId, 'start', component, metadata)}${ssrNormalizeOutput(value)}${renderBoundaryMarker(boundaryId, 'end', component, metadata)}`;
};

export const createSSRRenderContext = (): SSRRenderContext => {
  let boundaryCounter = 0;
  const teleportContainers = new Map<string, SSRTeleportContainerRecord>();
  const suspenseChunks: SSRSuspenseChunkRecord[] = [];
  const pendingSuspenseChunks: Promise<SSRSuspenseChunkRecord>[] = [];

  return {
    // 整个一次 SSR 渲染过程共享同一个 context，用来串起 boundary id、teleport 和 suspense patch。
    teleportContainers,
    suspenseChunks,
    pendingSuspenseChunks,
    nextBoundaryId() {
      boundaryCounter += 1;
      return `b${boundaryCounter}`;
    },
    registerTeleport(target, slotIndex, html) {
      const record =
        teleportContainers.get(target) ??
        {
          target,
          htmlParts: [],
          slotIndices: [],
        };
      record.htmlParts.push(html);
      record.slotIndices.push(slotIndex);
      teleportContainers.set(target, record);
    },
    registerSuspenseChunk(chunk) {
      // 先收集 Promise，等 drain 阶段再统一等待并生成可注入 patch。
      pendingSuspenseChunks.push(chunk);
      void chunk.then((resolved) => {
        suspenseChunks.push(resolved);
      });
    },
  };
};

const resolveSSRRenderContext = (
  ctx: Record<string, unknown> | undefined
): SSRRenderContext | null => {
  const candidate = ctx?.[SSR_RENDER_CONTEXT_KEY];
  return candidate && typeof candidate === 'object' ? (candidate as SSRRenderContext) : null;
};

export const attachSSRRenderContext = (
  values: Record<string, unknown> = {},
  renderContext = createSSRRenderContext()
): SSRRenderScope => {
  // render scope 只是普通对象扩展，避免让调用方必须引入额外上下文容器类型。
  return {
    ...values,
    [SSR_RENDER_CONTEXT_KEY]: renderContext,
  };
};

export const ssrRenderTeleportSlot = (
  slotIndex: number,
  target: unknown,
  value: unknown,
  ctx: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {}
): string => {
  const normalizedTarget =
    typeof target === 'string' && target.trim().length > 0 ? target.trim() : String(target ?? '');
  const renderContext = resolveSSRRenderContext(ctx);
  const slotMetadata = {
    ...metadata,
    to: normalizedTarget,
    transport: 'teleport-container-v1',
  };

  if (renderContext && normalizedTarget.length > 0) {
    // SSR 主体位置只留下占位 block，真实内容写入目标容器记录。
    const containerHtml = [
      renderTeleportContainerMarker(slotIndex, 'start', slotMetadata),
      ssrNormalizeOutput(value),
      renderTeleportContainerMarker(slotIndex, 'end', slotMetadata),
    ].join('');
    renderContext.registerTeleport(normalizedTarget, slotIndex, containerHtml);
  }

  // 主文档流中只保留空 block；真正的容器 HTML 通过 context 单独输出到目标位置。
  return ssrRenderBlockSlot(slotIndex, '', 'teleport', slotMetadata);
};

export const ssrRenderTeleportContainer = (
  ctx: Record<string, unknown> = {},
  target: string
): string => {
  const renderContext = resolveSSRRenderContext(ctx);
  // 同一 target 的多个 teleport 片段在服务端按注册顺序拼接，保证输出顺序与渲染顺序一致。
  return renderContext?.teleportContainers.get(target)?.htmlParts.join('') ?? '';
};

export const ssrRenderAllTeleportContainers = (
  ctx: Record<string, unknown> = {}
): Record<string, string> => {
  const renderContext = resolveSSRRenderContext(ctx);

  if (!renderContext) {
    return {};
  }

  return Object.fromEntries(
    [...renderContext.teleportContainers.entries()].map(([target, record]) => [
      target,
      record.htmlParts.join(''),
    ])
  );
};

export const ssrRenderSuspenseBoundary = (
  slotIndex: number,
  renderContent: () => string | Promise<string>,
  fallback: unknown,
  ctx: Record<string, unknown> = {},
  metadata: unknown = {}
): string => {
  const renderContext = resolveSSRRenderContext(ctx);
  const inputMetadata = isEnhancedBlockPayload(metadata)
    ? (isRecord(metadata.metadata) ? metadata.metadata : {})
    : (isRecord(metadata) ? metadata : {});
  const boundaryId = inputMetadata.boundaryId
    ? String(inputMetadata.boundaryId)
    : (renderContext?.nextBoundaryId() ?? `b${slotIndex}`);
  const resolvedMetadata = mergeBoundaryMeta(metadata, {
    boundaryId,
    slotIndex,
    component: 'Suspense',
  });

  try {
    // 先尝试同步拿内容；只有真正遇到 Promise/thenable 时才退回 fallback + patch 通道。
    const content = renderContent();

    if (content instanceof Promise) {
      // 异步内容尚未 resolve 时先输出 fallback，并登记后续 patch。
      renderContext?.registerSuspenseChunk(
        content.then((html) => ({
          boundaryId,
          slotIndex,
          html,
          metadata: mergeBoundaryMeta(resolvedMetadata, {
            status: 'resolved',
          }),
        }))
      );

      return ssrRenderEnhancedBoundary(
        boundaryId,
        'Suspense',
        fallback,
        mergeBoundaryMeta(resolvedMetadata, {
          status: 'pending',
          transport: 'suspense-patch-v1',
        })
      );
    }

    return ssrRenderEnhancedBoundary(
      boundaryId,
      'Suspense',
      content,
      mergeBoundaryMeta(resolvedMetadata, {
        status: 'resolved',
      })
    );
  } catch (error) {
    if (error instanceof Promise) {
      // 兼容“抛 Promise”式 Suspense 约定。
      renderContext?.registerSuspenseChunk(
        error.then(
          (html) => ({
            boundaryId,
            slotIndex,
            html: ssrNormalizeOutput(html),
            metadata: mergeBoundaryMeta(resolvedMetadata, {
              status: 'resolved',
            }),
          }),
          () => ({
            boundaryId,
            slotIndex,
            html: ssrNormalizeOutput(fallback),
            metadata: mergeBoundaryMeta(resolvedMetadata, {
              status: 'rejected',
            }),
          })
        )
      );

      return ssrRenderEnhancedBoundary(
        boundaryId,
        'Suspense',
        fallback,
        mergeBoundaryMeta(resolvedMetadata, {
          status: 'pending',
          transport: 'suspense-patch-v1',
        })
      );
    }

    throw error;
  }
};

export const ssrDrainSuspenseChunks = async (
  ctx: Record<string, unknown> = {}
): Promise<string[]> => {
  const renderContext = resolveSSRRenderContext(ctx);

  if (!renderContext || renderContext.pendingSuspenseChunks.length === 0) {
    return [];
  }

  const settled = await Promise.all(renderContext.pendingSuspenseChunks.splice(0));
  return settled.map((chunk) => {
    // drain 后返回的 patch 仍然包着独立 marker，客户端可以按 boundaryId 定位并局部替换。
    return [
      renderSuspensePatchMarker(chunk.boundaryId, 'start', chunk.metadata),
      chunk.html,
      renderSuspensePatchMarker(chunk.boundaryId, 'end', chunk.metadata),
    ].join('');
  });
};

export const applySSRChunk = (root: Node, chunk: string): boolean => {
  const template = document.createElement('template');
  template.innerHTML = chunk;
  const patchRecord = collectCommentBoundedNodes(template.content, SUSPENSE_PATCH_PATTERN)[0];

  if (!patchRecord) {
    return false;
  }

  const boundaryRecord = readBoundaryComments(root).find((record) => {
    return record.id === patchRecord.id;
  });

  if (!boundaryRecord) {
    return false;
  }

  // 先清空已有 boundary 内容，再把 patch 中的解析结果插回原位置。
  let cursor = boundaryRecord.start.nextSibling;

  while (cursor && cursor !== boundaryRecord.end) {
    const next = cursor.nextSibling;
    cursor.parentNode?.removeChild(cursor);
    cursor = next;
  }

  [...patchRecord.start.parentNode!.childNodes]
    .slice(
      [...patchRecord.start.parentNode!.childNodes].indexOf(patchRecord.start) + 1,
      [...patchRecord.start.parentNode!.childNodes].indexOf(patchRecord.end)
    )
    .forEach((node) => {
      // 这里 clone 一次，确保 patch 模板内容可安全复用于当前文档树。
      boundaryRecord.end.parentNode?.insertBefore(node.cloneNode(true), boundaryRecord.end);
    });

  const boundaryMetadata = patchRecord.metadata;
  const component = parseBoundaryMarker(boundaryRecord.start.data)?.component ?? 'Suspense';
  // patch 应用完成后，顺手把 boundary 自己的 start/end marker metadata 也更新到最新状态。
  boundaryRecord.start.data = renderBoundaryMarker(
    patchRecord.id,
    'start',
    component,
    boundaryMetadata
  ).slice(4, -3);
  boundaryRecord.end.data = renderBoundaryMarker(
    patchRecord.id,
    'end',
    component,
    boundaryMetadata
  ).slice(4, -3);
  return true;
};

export const ssrEvaluate = (expression: string, ctx: Record<string, unknown> = {}): unknown => {
  // SSR 表达式求值沿用模板运行时的 `with (ctx)` 约定，保持编译输出可直接复用。
  const evaluator = new Function(
    'ctx',
    `with (ctx) { return (${expression}); }`
  ) as (ctx: Record<string, unknown>) => unknown;

  return evaluator.call(ctx, ctx);
};

export const ssrResolveValue = async <T>(value: T | Promise<T>): Promise<T> => {
  return await value;
};
