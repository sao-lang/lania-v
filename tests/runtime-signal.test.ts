import { describe, expect, it } from 'vitest';

import { Scheduler, batch } from '@lania-v/runtime';
import { createComputedAccessor, createSignal } from '@lania-v/runtime';

const flushMicrotasks = async (times = 1): Promise<void> => {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
};

describe('createSignal', () => {
  it('short-circuits when Object.is reports no change', async () => {
    const scheduler = new Scheduler();
    const signal = createSignal(1, scheduler);
    let calls = 0;

    signal.updaters.add(() => {
      calls += 1;
    });

    signal.set(1);
    await flushMicrotasks();

    expect(calls).toBe(0);
  });

  it('coalesces multiple writes into one scheduled updater run', async () => {
    const scheduler = new Scheduler();
    const signal = createSignal(0, scheduler);
    const values: number[] = [];
    const job = () => {
      values.push(signal());
    };

    signal.updaters.add(job);
    signal.set(1);
    signal.set(2);
    await flushMicrotasks();

    expect(values).toEqual([2]);
  });

  it('merges multiple signal writes inside batch', async () => {
    const signal = createSignal(0);
    const values: number[] = [];

    signal.updaters.add(() => {
      values.push(signal());
    });

    batch(() => {
      signal.set(1);
      signal.set(2);
    });

    await flushMicrotasks();

    expect(values).toEqual([2]);
  });

  it('maintains updater add/delete semantics after compact storage expansion', async () => {
    const scheduler = new Scheduler();
    const signal = createSignal(0, scheduler);
    const calls: number[] = [];
    const jobs = Array.from({ length: 12 }, (_, index) => {
      return () => {
        calls.push(index);
      };
    });

    jobs.forEach((job) => {
      signal.updaters.add(job);
    });
    signal.updaters.delete(jobs[3]!);
    signal.updaters.delete(jobs[8]!);
    signal.set(1);
    await flushMicrotasks();

    expect(calls).toHaveLength(10);
    expect(calls).not.toContain(3);
    expect(calls).not.toContain(8);
    expect(signal.updaters.size).toBe(10);
  });
});

describe('createComputedAccessor', () => {
  it('recomputes on every read and exposes the same call style as a signal', () => {
    const count = createSignal(1);
    const doubled = createComputedAccessor(() => count() * 2);

    expect(typeof doubled).toBe('function');
    expect(doubled()).toBe(2);
    expect(doubled.peek()).toBe(2);

    count.set(3);

    // 编译产物依赖静态注入的订阅，句柄本身不缓存，因此读到的永远是最新值。
    expect(doubled()).toBe(6);
    expect(doubled.peek()).toBe(6);
  });
});
