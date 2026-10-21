/**
 * `Virtual`：窗口化列表。
 *
 * 支持的形态：
 * - 固定行高（`itemHeight: number`）：完全不测量，最快的路径；
 * - 预知逐项高度（`itemHeight: number[]`）：跳过首帧测量抖动；
 * - 未知行高（`itemHeight: (index) => number`）：用估算值占位，渲染后实测覆盖。
 *
 * 可变行高时，滚动位置会随行高变化而漂移。写入实测值后按「可视区首项」做锚定
 * 补偿：首项起始偏移变了，`scrollTop` 同步加上差值，用户看到的第一行不会跳走。
 *
 * 同时给出 `width` 与 `itemWidth` 时进入双向（纵向 + 横向）虚拟滚动。
 */
import { defineEnhancedComponent } from '../utils/factory';
import { appendRenderable, asRenderable } from '../utils/renderable';
import type {
  EnhancedRenderable,
  VirtualHost,
  VirtualProps,
  VirtualScrollState,
  VirtualSizeInput,
} from '../types';
import { buildRowModel, type VirtualRow } from './row-model';
import { isFixedSizeInput, VirtualSizeCache } from './size-cache';

interface RangeWindow {
  start: number;
  end: number;
}

interface RenderedRow {
  element: HTMLElement;
  rowIndex: number;
}

const DEFAULT_OVERSCAN = 2;
const DEFAULT_END_REACHED_THRESHOLD = 160;

/** 实测尺寸取整到 0.5px，避免亚像素抖动反复触发重排。 */
const quantize = (value: number): number => Math.round(value * 2) / 2;

const scheduleFrame = (run: () => void): number => {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(run) as unknown as number;
  }

  return setTimeout(run, 16) as unknown as number;
};

export const Virtual = defineEnhancedComponent(
  'Virtual',
  (props: VirtualProps): EnhancedRenderable => {
    const host = document.createElement(props.tag ?? 'div') as VirtualHost;
    const horizontal =
      typeof props.width === 'number' && props.itemWidth !== undefined;

    const rowModel = buildRowModel(props.value, props.groupBy);
    const rows = rowModel.rows;

    const fixedRowHeight = isFixedSizeInput(props.itemHeight)
      ? props.itemHeight
      : null;
    const uniformWidth =
      horizontal && isFixedSizeInput(props.itemWidth) ? props.itemWidth : null;

    const widthInput = horizontal
      ? (props.itemWidth as VirtualSizeInput)
      : undefined;

    // 单一账本记录每行尺寸（含分组头），这样前缀和就是真实的行偏移。
    const sizeCache = new VirtualSizeCache(props.itemHeight, widthInput);
    sizeCache.resize(rows.length);

    const isHeaderRow = (rowIndex: number): boolean =>
      rows[rowIndex]?.kind === 'header';

    // 分组头若未单独指定高度，就沿用它自身位置的估算值。
    if (props.headerHeight !== undefined) {
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        if (!isHeaderRow(rowIndex)) {
          continue;
        }

        const headerHeight = props.headerHeight;
        const size =
          typeof headerHeight === 'number'
            ? headerHeight
            : typeof headerHeight === 'function'
              ? headerHeight(rowIndex)
              : Array.isArray(headerHeight)
                ? headerHeight[rowIndex]
                : undefined;

        if (typeof size === 'number' && size > 0) {
          sizeCache.setSize(rowIndex, size);
        }
      }
    }

    const rowSize = (rowIndex: number): number => sizeCache.size(rowIndex);

    const rowWidth = (rowIndex: number): number =>
      sizeCache.estimateWidth(rowIndex);

    const rowOffset = (rowIndex: number): number => sizeCache.offset(rowIndex);

    const totalHeight = (): number => sizeCache.total;

    const totalWidth = (): number => {
      if (!horizontal) {
        return 0;
      }

      if (uniformWidth !== null) {
        return rows.length * uniformWidth;
      }

      let total = 0;
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        total += rowWidth(rowIndex);
      }
      return total;
    };

    /** 给定纵向偏移求行号；行数很大时用二分而不是逐行累加。 */
    const rowIndexAt = (offset: number): number => {
      if (rows.length === 0) {
        return 0;
      }

      let low = 0;
      let high = rows.length - 1;

      while (low < high) {
        const middle = Math.floor((low + high) / 2);

        if (rowOffset(middle + 1) <= offset) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }

      return low;
    };

    const resolveRange = (overscan: number): RangeWindow => {
      if (rows.length === 0) {
        return { start: 0, end: 0 };
      }

      const scrollTop = Math.max(host.scrollTop, 0);
      const start = Math.max(0, rowIndexAt(scrollTop) - overscan);
      const viewEnd = scrollTop + props.height;
      let end = start;

      // 行的 `top` 等于它的起始偏移，因此起始点仍在视口内的行都要渲染。
      while (end < rows.length && rowOffset(end) <= viewEnd) {
        end += 1;
      }

      return {
        start,
        end: Math.min(rows.length, Math.max(end, start) + overscan),
      };
    };

    // —— 宿主结构 ——

    host.style.overflow = 'auto';
    host.style.position = 'relative';
    host.style.height = `${props.height}px`;
    if (horizontal) {
      host.style.width = `${props.width}px`;
    }

    // spacer 撑出完整滚动范围，行绝对定位在它内部。
    const spacer = document.createElement('div');
    spacer.style.position = 'relative';
    spacer.dataset.virtualSpacer = '';
    host.appendChild(spacer);

    // sticky 头单独一层：滚动时不需要跟着窗口重建。
    const stickyLayer = document.createElement('div');
    stickyLayer.style.position = 'sticky';
    stickyLayer.style.top = '0';
    stickyLayer.style.left = '0';
    stickyLayer.style.height = '0';
    stickyLayer.style.width = '100%';
    stickyLayer.style.zIndex = '1';
    stickyLayer.style.pointerEvents = 'none';
    spacer.appendChild(stickyLayer);

    const fallbackHost = document.createElement('div');
    host.appendChild(fallbackHost);

    // —— 状态 ——

    let stickyGroup: string | null = null;
    let lastScrollTop = 0;
    let endReached = false;
    let pendingFrame: number | null = null;
    let observed: Element[] = [];
    let observer: ResizeObserver | null = null;

    const resolveFallback = (): EnhancedRenderable => {
      const fallback = props.fallback;

      return typeof fallback === 'function'
        ? (fallback as () => EnhancedRenderable)()
        : (fallback as EnhancedRenderable);
    };

    const renderRowContent = (row: VirtualRow): EnhancedRenderable => {
      if (row.kind === 'header') {
        const header = props.header;

        return typeof header === 'function'
          ? (header as (group: string, index: number) => EnhancedRenderable)(
              row.group ?? '',
              row.itemIndex
            )
          : null;
      }

      const item = props.value[row.itemIndex];

      return typeof props.children === 'function'
        ? (props.children as (item: unknown, index: number) => EnhancedRenderable)(
            item,
            row.itemIndex
          )
        : (asRenderable(props.children) as EnhancedRenderable);
    };

    const createRowElement = (
      row: VirtualRow,
      rowIndex: number
    ): HTMLElement => {
      const element = document.createElement('div');
      element.style.position = 'absolute';
      element.style.top = `${rowOffset(rowIndex)}px`;
      element.style.left = '0';
      element.dataset.row = String(rowIndex);

      if (horizontal) {
        element.style.width = `${rowWidth(rowIndex)}px`;
      } else {
        element.style.right = '0';
      }

      // 固定行高直接写死，浏览器不必测量，也不会有抖动。
      if (fixedRowHeight !== null && row.kind === 'item') {
        element.style.height = `${fixedRowHeight}px`;
      }

      if (props.key && row.kind === 'item') {
        element.dataset.key = String(
          props.key(props.value[row.itemIndex]!, row.itemIndex)
        );
      }

      return element;
    };

    const collectRenderedRows = (): RenderedRow[] =>
      [...spacer.querySelectorAll<HTMLElement>('[data-row]')].map((element) => ({
        element,
        rowIndex: Number(element.dataset.row),
      }));

    const measureRows = (rendered: readonly RenderedRow[]): void => {
      for (const { element, rowIndex } of rendered) {
        // jsdom 等环境没有真实布局：保留估算值，避免把尺寸写成 0。
        const rect = element.getBoundingClientRect();
        const measuredHeight = quantize(rect.height);
        const measuredWidth = quantize(rect.width);

        if (measuredHeight > 0) {
          sizeCache.setSize(rowIndex, measuredHeight);
        }

        if (horizontal && uniformWidth === null && measuredWidth > 0) {
          sizeCache.setSize(rowIndex, measuredWidth);
        }

        props.onResize?.(rowIndex, {
          height: measuredHeight,
          width: measuredWidth,
        });
      }
    };

    const positionStickyHeader = (rendered: readonly RenderedRow[]): void => {
      if (!props.groupBy) {
        stickyLayer.replaceChildren();
        stickyGroup = null;
        return;
      }

      const firstVisible = rowIndexAt(Math.max(host.scrollTop, 0));
      let headerIndex = -1;

      for (let index = firstVisible; index >= 0; index -= 1) {
        if (rows[index]?.kind === 'header') {
          headerIndex = index;
          break;
        }
      }

      if (headerIndex < 0) {
        stickyLayer.replaceChildren();
        stickyGroup = null;
        return;
      }

      const row = rows[headerIndex]!;
      const group = row.group ?? '';

      if (stickyGroup !== group || stickyLayer.childElementCount === 0) {
        stickyGroup = group;

        const clone = document.createElement('div');
        clone.style.position = 'relative';
        clone.dataset.stickyHeader = group;

        const source = rendered.find(
          (entry) => entry.rowIndex === headerIndex
        )?.element;

        // 头行不在渲染窗口内时按模板重建一次，避免滚动时 sticky 头闪空。
        appendRenderable(
          clone,
          source
            ? [...source.childNodes].map((node) => node.cloneNode(true))
            : renderRowContent(row)
        );

        const headerHeight = props.headerHeight;

        if (typeof headerHeight === 'number') {
          clone.style.height = `${headerHeight}px`;
        }

        stickyLayer.replaceChildren(clone);
      }

      // 下一个分组头顶到可视区时把当前 sticky 头往上推，形成「跟随推走」。
      const nextOffset =
        headerIndex + 1 < rows.length
          ? rowOffset(headerIndex + 1)
          : Number.POSITIVE_INFINITY;
      const headerSize = rowSize(headerIndex);
      const pinned = nextOffset - host.scrollTop;

      stickyLayer.style.transform =
        pinned < headerSize
          ? `translateY(${pinned - headerSize}px)`
          : 'translateY(0)';
    };

    const notifyEndReached = (): void => {
      if (!props.onEndReached) {
        return;
      }

      const threshold =
        props.endReachedThreshold ?? DEFAULT_END_REACHED_THRESHOLD;
      const distance = totalHeight() - host.scrollTop - props.height;

      if (distance > threshold) {
        endReached = false;
        return;
      }

      // `hasMore === false` 表示数据已到底；此时只提醒一次。
      if (endReached && props.hasMore !== true) {
        return;
      }

      endReached = true;
      props.onEndReached();
    };

    const emitScroll = (start: number, end: number): void => {
      const direction: VirtualScrollState['direction'] =
        host.scrollTop >= lastScrollTop ? 'forward' : 'backward';

      lastScrollTop = host.scrollTop;

      props.onScroll?.({
        scrollTop: host.scrollTop,
        scrollLeft: host.scrollLeft,
        startIndex: start,
        endIndex: end,
        direction,
      });

      notifyEndReached();
    };

    const render = (): void => {
      if (rows.length === 0) {
        spacer.style.height = '0px';
        spacer.querySelectorAll('[data-row]').forEach((element) => element.remove());
        stickyLayer.replaceChildren();
        stickyGroup = null;
        fallbackHost.replaceChildren();
        appendRenderable(fallbackHost, resolveFallback());
        return;
      }

      fallbackHost.replaceChildren();

      const overscan = Math.max(0, props.overscan ?? DEFAULT_OVERSCAN);
      const { start, end } = resolveRange(overscan);

      spacer.style.height = `${totalHeight()}px`;
      spacer.style.width = horizontal
        ? `${Math.max(totalWidth(), props.width ?? 0)}px`
        : '100%';

      // 只保留窗口内的行，其余已渲染行全部回收。
      spacer.querySelectorAll<HTMLElement>('[data-row]').forEach((element) => {
        element.remove();
      });

      const rendered: RenderedRow[] = [];

      for (let rowIndex = start; rowIndex < end; rowIndex += 1) {
        const row = rows[rowIndex];

        if (!row) {
          continue;
        }

        const element = createRowElement(row, rowIndex);
        appendRenderable(element, renderRowContent(row));
        spacer.appendChild(element);
        rendered.push({ element, rowIndex });
      }

      positionStickyHeader(rendered);
      observeRows(rendered);
      emitScroll(start, end);
    };

    /**
     * 尺寸变化后重排并做滚动锚定。
     * 只有「可视区首行之前」的行变高才会推动内容，因此只对这段区间累加 delta。
     */
    const measureAndRealign = (): void => {
      const rendered = collectRenderedRows();

      if (rendered.length === 0) {
        return;
      }

      const firstVisible = rowIndexAt(Math.max(host.scrollTop, 0));
      const before: [number, number][] = [];

      for (const { element, rowIndex } of rendered) {
        if (rowIndex >= firstVisible) {
          continue;
        }

        const height = quantize(element.getBoundingClientRect().height);

        if (height > 0) {
          before.push([rowIndex, height]);
        }
      }

      const deltaBefore = sizeCache.applyMeasurements(before);

      measureRows(rendered);

      // 首行之前的行高变化会让首行漂移，按 delta 反向补偿 scrollTop。
      if (deltaBefore !== 0) {
        host.scrollTop = Math.max(0, host.scrollTop + deltaBefore);
      }

      render();
    };

    const observeRows = (rendered: readonly RenderedRow[]): void => {
      if (typeof ResizeObserver !== 'function') {
        return;
      }

      observer ??= new ResizeObserver(() => {
        // 观察回调里读到的是最新布局，此时可以安全测量。
        schedule(measureAndRealign);
      });

      const next: Element[] = [];

      for (const { element } of rendered) {
        next.push(element);

        if (!observed.includes(element)) {
          observer.observe(element);
        }
      }

      // 回收已经离开窗口的行，避免 observer 持有旧节点。
      for (const element of observed) {
        if (!next.includes(element)) {
          observer.unobserve(element);
        }
      }
      observed = next;
    };

    const schedule = (run: () => void): void => {
      if (pendingFrame !== null) {
        return;
      }

      pendingFrame = scheduleFrame(() => {
        pendingFrame = null;
        run();
      });
    };

    // —— 命令式 API ——

    const scrollToOffset = (offset: number): void => {
      host.scrollTop = Math.max(0, offset);
      render();
    };

    const scrollToIndex = (
      index: number,
      options: { align?: 'start' | 'center' | 'end' } = {}
    ): void => {
      if (rows.length === 0) {
        return;
      }

      const clamped = Math.max(0, Math.min(index, props.value.length - 1));
      const rowIndex = rowModel.rowOfItem[clamped] ?? 0;
      const offset = rowOffset(rowIndex);
      const size = rowSize(rowIndex);
      const align = options.align ?? 'start';
      const next =
        align === 'start'
          ? offset
          : align === 'center'
            ? offset - (props.height - size) / 2
            : offset - (props.height - size);

      scrollToOffset(next);
    };

    host.scrollToIndex = scrollToIndex;
    host.scrollToOffset = scrollToOffset;
    host.measure = measureAndRealign;

    // 滚动直接同步重排：浏览器本身会合并同一帧内的写入，
    // 而同步渲染让 `scrollTop` 赋值后立即可以读到新窗口。
    host.addEventListener('scroll', render, { passive: true });

    // `scrollTo` 接受偏移数字或 `#index`，便于在声明式模板里直接绑定。
    if (props.scrollTo != null) {
      if (typeof props.scrollTo === 'number') {
        host.scrollTop = Math.max(0, props.scrollTo);
      } else if (props.scrollTo.startsWith('#')) {
        const index = Number(props.scrollTo.slice(1));

        if (Number.isFinite(index)) {
          host.scrollTop = rowOffset(rowModel.rowOfItem[index] ?? 0);
        }
      }
    }

    lastScrollTop = host.scrollTop;
    render();

    return host;
  }
);
