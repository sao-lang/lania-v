// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { Reach } from '@lania-v/runtime/advanced';
import { REACH_SENTINEL_ATTRIBUTE } from '../packages/runtime/src/advanced/enhanced/reach';

describe('Reach', () => {
  it('renders children plus a sentinel', () => {
    const host = Reach({
      onReach: () => {},
      children: 'content',
    }) as HTMLElement;

    expect(host.textContent).toBe('content');
    expect(host.querySelector(`[${REACH_SENTINEL_ATTRIBUTE}]`)).not.toBeNull();
  });

  it('keeps the wrapper layout-neutral', () => {
    const host = Reach({ children: null }) as HTMLElement;
    expect(host.style.display).toBe('contents');
  });

  it('observes the sentinel once mounted, with the configured rootMargin', async () => {
    const observed: Element[] = [];

    class FakeObserver {
      static lastOptions: IntersectionObserverInit | undefined;
      constructor(
        _callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit
      ) {
        FakeObserver.lastOptions = options;
      }
      observe(target: Element) {
        observed.push(target);
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }

    const original = globalThis.IntersectionObserver;
    (globalThis as any).IntersectionObserver = FakeObserver;

    try {
      const onReach = vi.fn();
      const host = Reach({ onReach, rootMargin: '200px' }) as HTMLElement;
      document.body.appendChild(host);

      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(observed).toHaveLength(1);
      expect(observed[0]!.hasAttribute(REACH_SENTINEL_ATTRIBUTE)).toBe(true);
      expect(FakeObserver.lastOptions?.rootMargin).toBe('200px');
      expect(onReach).not.toHaveBeenCalled();
    } finally {
      (globalThis as any).IntersectionObserver = original;
    }
  });

  /** 构造一个可滚动容器替身：scrollHeight/clientHeight 固定，scrollTop 可写。 */
  const createScrollBox = (scrollHeight: number, clientHeight: number) => {
    const box = document.createElement('div');
    // 必须是真正的滚动容器样式，否则会退回视口几何判定。
    box.style.overflow = 'auto';
    box.style.height = `${clientHeight}px`;
    document.body.appendChild(box);

    let top = 0;
    Object.defineProperty(box, 'scrollHeight', { get: () => scrollHeight });
    Object.defineProperty(box, 'clientHeight', { get: () => clientHeight });
    Object.defineProperty(box, 'scrollTop', {
      get: () => top,
      set: (value: number) => {
        top = value;
      },
    });

    return box;
  };

  /** 让 Reach 只走滚动判定：移除 IntersectionObserver，避免测试间互相污染。 */
  const withoutIntersectionObserver = async (run: () => Promise<void>) => {
    const original = globalThis.IntersectionObserver;
    // @ts-expect-error 测试里刻意移除。
    delete (globalThis as { IntersectionObserver?: unknown })
      .IntersectionObserver;

    try {
      await run();
    } finally {
      (globalThis as any).IntersectionObserver = original;
    }
  };

  it('fires only once in once mode when the bottom is reached repeatedly', async () => {
    await withoutIntersectionObserver(async () => {
      // `root` 模式按滚动位置判定：总高 1000，视口 100，滚到 900 即到底。
      const scroller = createScrollBox(1000, 100);
      const onReach = vi.fn();

      const host = Reach({
        root: scroller,
        once: true,
        onReach,
      }) as HTMLElement;
      scroller.appendChild(host);

      await new Promise((resolve) => setTimeout(resolve, 30));

      // 尚未到底。
      scroller.scrollTop = 100;
      scroller.dispatchEvent(new Event('scroll'));
      expect(onReach).not.toHaveBeenCalled();

      // 到底触发一次。
      scroller.scrollTop = 900;
      scroller.dispatchEvent(new Event('scroll'));
      expect(onReach).toHaveBeenCalledTimes(1);

      // once 模式下反复到底也不重复触发。
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll'));
      scroller.scrollTop = 900;
      scroller.dispatchEvent(new Event('scroll'));
      expect(onReach).toHaveBeenCalledTimes(1);
    });
  });

  it('re-arms after leaving the bottom when once is false', async () => {
    await withoutIntersectionObserver(async () => {
      const scroller = createScrollBox(1000, 100);
      const onReach = vi.fn();

      const host = Reach({ root: scroller, onReach }) as HTMLElement;
      scroller.appendChild(host);

      await new Promise((resolve) => setTimeout(resolve, 30));

      scroller.scrollTop = 900;
      scroller.dispatchEvent(new Event('scroll'));
      expect(onReach).toHaveBeenCalledTimes(1);

      // 离开底部后重新武装，可再次触发。
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll'));
      scroller.scrollTop = 900;
      scroller.dispatchEvent(new Event('scroll'));
      expect(onReach).toHaveBeenCalledTimes(2);
    });
  });

  it('respects rootMargin as an early-trigger distance', async () => {
    await withoutIntersectionObserver(async () => {
      const scroller = createScrollBox(1000, 100);
      const onReach = vi.fn();

      const host = Reach({
        root: scroller,
        rootMargin: '200px',
        onReach,
      }) as HTMLElement;
      scroller.appendChild(host);

      await new Promise((resolve) => setTimeout(resolve, 30));

      // 距底部 300px：还没进入 200px 的提前量范围。
      scroller.scrollTop = 600;
      scroller.dispatchEvent(new Event('scroll'));
      expect(onReach).not.toHaveBeenCalled();

      // 距底部 100px：已在提前量内。
      scroller.scrollTop = 800;
      scroller.dispatchEvent(new Event('scroll'));
      expect(onReach).toHaveBeenCalledTimes(1);
    });
  });
});
