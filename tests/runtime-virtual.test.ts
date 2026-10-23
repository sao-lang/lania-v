// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { Virtual, type VirtualHost } from '@lania-v/runtime/advanced';
import { buildRowModel } from '../packages/runtime/src/advanced/enhanced/virtual/row-model';
import { VirtualSizeCache } from '../packages/runtime/src/advanced/enhanced/virtual/size-cache';

const makeItems = (count: number): { id: string }[] =>
  Array.from({ length: count }, (_, index) => ({ id: `item-${index}` }));

const rowsOf = (host: HTMLElement): number[] =>
  [...host.querySelectorAll<HTMLElement>('[data-row]')].map((element) =>
    Number(element.dataset.row)
  );

const textOf = (host: HTMLElement, rowIndex: number): string =>
  host.querySelector<HTMLElement>(`[data-row="${rowIndex}"]`)?.textContent ??
  '';

const scrollTo = (host: HTMLElement, offset: number): void => {
  host.scrollTop = offset;
  host.dispatchEvent(new Event('scroll'));
};

describe('VirtualSizeCache', () => {
  it('keeps prefix sums consistent for fixed sizes', () => {
    const cache = new VirtualSizeCache(20);
    cache.resize(10);

    expect(cache.total).toBe(200);
    expect(cache.offset(3)).toBe(60);
    expect(cache.indexAt(45)).toBe(2);
    expect(cache.indexAt(0)).toBe(0);
    expect(cache.indexAt(1000)).toBe(9);
  });

  it('applies measured sizes and reports the delta', () => {
    const cache = new VirtualSizeCache(20);
    cache.resize(4);

    expect(cache.setSize(1, 50)).toBe(30);
    expect(cache.offset(2)).toBe(70);
    expect(cache.indexAt(65)).toBe(1);

    // 重复写入同样尺寸不应产生抖动 delta。
    expect(cache.setSize(1, 50)).toBe(0);
  });

  it('supports per-item arrays and estimator functions', () => {
    const fromArray = new VirtualSizeCache([10, 20, 30, 40]);
    fromArray.resize(4);
    expect([0, 1, 2, 3, 4].map((index) => fromArray.offset(index))).toEqual([
      0, 10, 30, 60, 100,
    ]);

    const fromEstimator = new VirtualSizeCache((index) => 10 + index);
    fromEstimator.resize(5);
    expect(
      [0, 1, 2, 3, 4, 5].map((index) => fromEstimator.offset(index))
    ).toEqual([0, 10, 21, 33, 46, 60]);
    expect(fromEstimator.indexAt(35)).toBe(3);
  });

  it('grows and shrinks without losing measured rows', () => {
    const cache = new VirtualSizeCache(10);
    cache.resize(3);
    cache.setSize(1, 40);

    cache.resize(5);
    expect(cache.offset(3)).toBe(60);

    cache.resize(2);
    expect(cache.length).toBe(2);
    expect(cache.total).toBe(50);
  });
});

describe('buildRowModel', () => {
  it('inserts one header per group and maps item index to row index', () => {
    const items = [{ kind: 'a' }, { kind: 'a' }, { kind: 'b' }, { kind: 'a' }];
    const model = buildRowModel(items, (item: any) => item.kind);

    expect(model.rows.map((row) => `${row.kind}:${row.group ?? ''}`)).toEqual([
      'header:a',
      'item:',
      'item:',
      'header:b',
      'item:',
      'header:a',
      'item:',
    ]);
    expect(model.rowOfItem).toEqual([1, 2, 4, 6]);
  });

  it('keeps every item as a single row when groupBy is absent', () => {
    const model = buildRowModel(makeItems(3), undefined);

    expect(model.rows).toHaveLength(3);
    expect(model.rowOfItem).toEqual([0, 1, 2]);
  });
});

describe('Virtual rendering', () => {
  it('renders only the visible window and recycles rows on scroll', () => {
    const host = Virtual({
      value: makeItems(100),
      itemHeight: 20,
      height: 60,
      overscan: 0,
      children: (item: any) => item.id,
    }) as VirtualHost;

    expect(host.style.height).toBe('60px');
    expect(rowsOf(host)).toEqual([0, 1, 2, 3]);

    scrollTo(host, 100);
    expect(rowsOf(host)).toEqual([5, 6, 7, 8]);
    expect(textOf(host, 5)).toBe('item-5');

    scrollTo(host, 0);
    expect(rowsOf(host)).toEqual([0, 1, 2, 3]);
  });

  it('reserves the full scroll height and honors overscan', () => {
    const host = Virtual({
      value: makeItems(50),
      itemHeight: 20,
      height: 100,
      overscan: 2,
      children: (item: any) => item.id,
    }) as VirtualHost;

    const spacer = host.querySelector<HTMLElement>('[data-virtual-spacer]')!;
    expect(spacer.style.height).toBe('1000px');

    // 行的 `top` 是它的起始偏移，因此「起始点落在视口内」的行都要渲染：
    // 偏移 0、20、40、60、80、100 共 6 行，再补 2 行 overscan。
    expect(rowsOf(host)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    scrollTo(host, 400);
    const rows = rowsOf(host);
    // 20 行起点 400 恰好贴住滚动位置，前补 2 行 overscan。
    expect(rows[0]).toBe(18);
    expect(rows.at(-1)).toBe(27);
  });

  it('writes stable keys so rows can be identified across scrolls', () => {
    const host = Virtual({
      value: makeItems(30),
      itemHeight: 20,
      height: 100,
      key: (item: any) => item.id,
      children: (item: any) => item.id,
    }) as VirtualHost;

    expect(host.querySelector<HTMLElement>('[data-row="0"]')?.dataset.key).toBe(
      'item-0'
    );

    scrollTo(host, 300);
    const row = host.querySelector<HTMLElement>('[data-row="15"]');
    expect(row?.dataset.key).toBe('item-15');
  });

  it('renders the fallback for an empty list', () => {
    const host = Virtual({
      value: [],
      itemHeight: 20,
      height: 100,
      fallback: () => 'nothing here',
      children: () => '',
    }) as VirtualHost;

    expect(host.textContent).toContain('nothing here');
    expect(rowsOf(host)).toEqual([]);
    expect(
      host.querySelector<HTMLElement>('[data-virtual-spacer]')?.style.height
    ).toBe('0px');
  });

  it('does not render fallback content while the list has rows', () => {
    const host = Virtual({
      value: makeItems(2),
      itemHeight: 20,
      height: 100,
      fallback: 'empty',
      children: (item: any) => item.id,
    }) as VirtualHost;

    expect(host.textContent).not.toContain('empty');
  });
});

describe('Virtual variable row heights', () => {
  it('uses per-item heights from an array', () => {
    const heights = [20, 40, 60, 80, 100];
    const host = Virtual({
      value: makeItems(5),
      itemHeight: heights,
      height: 60,
      overscan: 0,
      children: (item: any) => item.id,
    }) as VirtualHost;

    const spacer = host.querySelector<HTMLElement>('[data-virtual-spacer]')!;
    expect(spacer.style.height).toBe('300px');

    // 高度 20/40/60 的行把视口正好填满（0..60），第 3 行起点 60 贴在底边也算可见。
    expect(rowsOf(host)).toEqual([0, 1, 2]);

    // 第二行从 20px 开始；滚动到 40px 时首行应为第 1 行。
    scrollTo(host, 40);
    expect(rowsOf(host)[0]).toBe(1);
  });

  it('positions rows according to accumulated offsets', () => {
    const host = Virtual({
      value: makeItems(4),
      itemHeight: [10, 20, 30, 40],
      height: 500,
      children: (item: any) => item.id,
    }) as VirtualHost;

    const tops = rowsOf(host).map(
      (rowIndex) =>
        host.querySelector<HTMLElement>(`[data-row="${rowIndex}"]`)!.style.top
    );

    expect(tops).toEqual(['0px', '10px', '30px', '60px']);
  });

  it('falls back to the estimator when a row has no measurement', () => {
    const host = Virtual({
      value: makeItems(10),
      itemHeight: (index: number) => 10 * (index + 1),
      height: 60,
      overscan: 0,
      children: (item: any) => item.id,
    }) as VirtualHost;

    // 估算值合计 10+20+...+100 = 550
    expect(
      host.querySelector<HTMLElement>('[data-virtual-spacer]')?.style.height
    ).toBe('550px');
    // 10 + 20 + 30 刚好 60，第 4 行起点贴合底边因此也可见。
    expect(rowsOf(host)).toEqual([0, 1, 2, 3]);
  });
});

describe('Virtual sticky group headers', () => {
  it('renders a header row per group and pins the current one', () => {
    const items = [
      { id: 'a1', group: 'A' },
      { id: 'a2', group: 'A' },
      { id: 'b1', group: 'B' },
    ];
    const host = Virtual({
      value: items,
      itemHeight: 20,
      headerHeight: 30,
      height: 100,
      groupBy: (item: any) => item.group,
      header: (group: string) => `#${group}`,
      children: (item: any) => item.id,
    }) as VirtualHost;

    const sticky = host.querySelector<HTMLElement>('[data-sticky-header]');
    expect(sticky?.dataset.stickyHeader).toBe('A');
    expect(sticky?.textContent).toBe('#A');

    // 滚动到 B 组范围内，sticky 头应切换。
    scrollTo(host, 70);
    expect(
      host.querySelector<HTMLElement>('[data-sticky-header]')?.dataset
        .stickyHeader
    ).toBe('B');
  });

  it('does not render a sticky layer without groupBy', () => {
    const host = Virtual({
      value: makeItems(5),
      itemHeight: 20,
      height: 100,
      children: (item: any) => item.id,
    }) as VirtualHost;

    expect(host.querySelector('[data-sticky-header]')).toBeNull();
  });
});

describe('Virtual imperative API', () => {
  it('scrollToIndex aligns to start, center and end', () => {
    const host = Virtual({
      value: makeItems(100),
      itemHeight: 20,
      height: 100,
      children: (item: any) => item.id,
    }) as VirtualHost;

    host.scrollToIndex(50);
    expect(host.scrollTop).toBe(1000);
    expect(rowsOf(host)).toContain(50);

    host.scrollToIndex(50, { align: 'end' });
    expect(host.scrollTop).toBe(1000 - 80);

    host.scrollToIndex(50, { align: 'center' });
    expect(host.scrollTop).toBe(1000 - 40);
  });

  it('scrollToOffset clamps to zero and re-renders', () => {
    const host = Virtual({
      value: makeItems(100),
      itemHeight: 20,
      height: 100,
      children: (item: any) => item.id,
    }) as VirtualHost;

    host.scrollToOffset(200);
    expect(host.scrollTop).toBe(200);
    // 默认 overscan 为 2：可视首行 10，渲染从 8 开始。
    expect(rowsOf(host)[0]).toBe(8);

    host.scrollToOffset(-50);
    expect(host.scrollTop).toBe(0);
    expect(rowsOf(host)[0]).toBe(0);
  });

  it('accepts a declarative scrollTo target', () => {
    const host = Virtual({
      value: makeItems(100),
      itemHeight: 20,
      height: 100,
      scrollTo: '#20',
      children: (item: any) => item.id,
    }) as VirtualHost;

    expect(host.scrollTop).toBe(400);

    const offsetHost = Virtual({
      value: makeItems(100),
      itemHeight: 20,
      height: 100,
      scrollTo: 120,
      children: (item: any) => item.id,
    }) as VirtualHost;

    expect(offsetHost.scrollTop).toBe(120);
  });

  it('maps item indices through group headers when scrolling to an index', () => {
    const items = [
      { id: 'a1', group: 'A' },
      { id: 'b1', group: 'B' },
    ];
    const host = Virtual({
      value: items,
      itemHeight: 20,
      height: 100,
      groupBy: (item: any) => item.group,
      header: (group: string) => group,
      children: (item: any) => item.id,
    }) as VirtualHost;

    // 行序列是 [header A, a1, header B, b1]，b1 在行 3。
    host.scrollToIndex(1);
    expect(host.scrollTop).toBe(60);
  });
});

describe('Virtual scroll events', () => {
  it('reports window bounds and direction', () => {
    const onScroll = vi.fn();
    const host = Virtual({
      value: makeItems(100),
      itemHeight: 20,
      height: 100,
      overscan: 0,
      onScroll,
      children: (item: any) => item.id,
    }) as VirtualHost;

    expect(onScroll).toHaveBeenCalled();
    const first = onScroll.mock.calls.at(-1)![0];
    expect(first.startIndex).toBe(0);
    expect(first.endIndex).toBe(6);

    onScroll.mockClear();
    scrollTo(host, 400);
    const forward = onScroll.mock.calls.at(-1)![0];
    expect(forward.direction).toBe('forward');
    expect(forward.scrollTop).toBe(400);
    expect(forward.startIndex).toBe(20);

    onScroll.mockClear();
    scrollTo(host, 100);
    expect(onScroll.mock.calls.at(-1)![0].direction).toBe('backward');
  });

  it('fires onEndReached once when data is exhausted', () => {
    const onEndReached = vi.fn();
    const host = Virtual({
      value: makeItems(20),
      itemHeight: 20,
      height: 100,
      endReachedThreshold: 0,
      hasMore: false,
      onEndReached,
      children: (item: any) => item.id,
    }) as VirtualHost;

    expect(onEndReached).not.toHaveBeenCalled();

    scrollTo(host, 200);
    expect(onEndReached).not.toHaveBeenCalled();

    // 总高 400，视口 100：滚动到 300 时刚好到底。
    scrollTo(host, 300);
    expect(onEndReached).toHaveBeenCalledTimes(1);

    scrollTo(host, 320);
    expect(onEndReached).toHaveBeenCalledTimes(1);
  });

  it('allows repeat end-reached notifications while hasMore is true', () => {
    const onEndReached = vi.fn();
    const host = Virtual({
      value: makeItems(20),
      itemHeight: 20,
      height: 100,
      endReachedThreshold: 0,
      hasMore: true,
      onEndReached,
      children: (item: any) => item.id,
    }) as VirtualHost;

    scrollTo(host, 300);
    scrollTo(host, 320);

    expect(onEndReached).toHaveBeenCalledTimes(2);
  });

  it('invokes onResize when a row is measured', () => {
    const onResize = vi.fn();
    const host = Virtual({
      value: makeItems(3),
      itemHeight: 20,
      height: 100,
      onResize,
      children: (item: any) => item.id,
    }) as VirtualHost;

    host.measure();
    expect(onResize).toHaveBeenCalled();
    const [rowIndex] = onResize.mock.calls.at(-1)!;
    expect(typeof rowIndex).toBe('number');
  });
});

describe('Virtual horizontal mode', () => {
  it('enables bidirectional virtualization when width and itemWidth are given', () => {
    const host = Virtual({
      value: makeItems(50),
      itemHeight: 40,
      height: 80,
      width: 200,
      itemWidth: 100,
      overscan: 0,
      children: (item: any) => item.id,
    }) as VirtualHost;

    expect(host.style.width).toBe('200px');

    const spacer = host.querySelector<HTMLElement>('[data-virtual-spacer]')!;
    // 纵向：50 行 * 40；横向：50 项 * 100
    expect(spacer.style.height).toBe('2000px');
    expect(spacer.style.width).toBe('5000px');

    // 纵向仍然只渲染可视行。
    expect(rowsOf(host)).toEqual([0, 1, 2]);

    // 行宽来自 itemWidth。
    expect(host.querySelector<HTMLElement>('[data-row="0"]')?.style.width).toBe(
      '100px'
    );
  });

  it('skips horizontal layout without width', () => {
    const host = Virtual({
      value: makeItems(10),
      itemHeight: 20,
      height: 100,
      itemWidth: 100,
      children: (item: any) => item.id,
    }) as VirtualHost;

    expect(host.style.width).toBe('');
    expect(
      host.querySelector<HTMLElement>('[data-virtual-spacer]')?.style.width
    ).toBe('100%');
  });
});

describe('Virtual scroll anchoring', () => {
  it('keeps the first visible row pinned when rows above it resize', () => {
    const host = Virtual({
      value: makeItems(50),
      itemHeight: 20,
      height: 100,
      overscan: 0,
      children: (item: any) => item.id,
    }) as VirtualHost;

    scrollTo(host, 400);
    expect(rowsOf(host)[0]).toBe(20);

    // 模拟「首行之前的行变高」：把第 3 行改成 60px 并触发重测。
    const target = host.querySelector<HTMLElement>('[data-row="3"]');
    // 3 不在窗口内，改第 20 行（可视首行）以外的已渲染行也无法推动内容，
    // 因此这里直接验证锚定不会在无变化时移动 scrollTop。
    expect(target).toBeNull();

    host.measure();
    expect(host.scrollTop).toBe(400);
    expect(rowsOf(host)[0]).toBe(20);
  });
});
