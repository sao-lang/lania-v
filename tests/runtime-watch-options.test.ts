import { describe, expect, it } from 'vitest';

import {
  createSignal,
  watch,
  type Scheduler,
  type WatchStopHandle,
} from '@lania-v/runtime';

const flush = async (times = 3): Promise<void> => {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
};

describe('watch options', () => {
  it('runs the callback immediately when immediate is true', async () => {
    const count = createSignal(1);
    const events: Array<[number, number | undefined]> = [];

    watch(
      count,
      (current, previous) => {
        events.push([current, previous]);
      },
      { immediate: true }
    );

    expect(events).toEqual([[1, undefined]]);

    count.set(2);
    await flush();
    expect(events).toEqual([
      [1, undefined],
      [2, 1],
    ]);
  });

  it('does not run immediately by default', async () => {
    const count = createSignal(1);
    const events: number[] = [];

    watch(count, (current) => {
      events.push(current);
    });

    expect(events).toEqual([]);

    count.set(2);
    await flush();
    expect(events).toEqual([2]);
  });

  it('skips callbacks when the deep snapshot is unchanged', async () => {
    const form = createSignal({ user: { name: 'Ada' } });
    const events: Array<{ name: string }> = [];

    watch(
      form,
      (current, previous) => {
        events.push({ name: `${previous?.user.name}->${current.user.name}` });
      },
      { deep: true }
    );

    // 内容相同的新对象不触发回调。
    form.set({ user: { name: 'Ada' } });
    await flush();
    expect(events).toEqual([]);

    form.set({ user: { name: 'Grace' } });
    await flush();
    expect(events).toEqual([{ name: 'Ada->Grace' }]);
  });

  it('keeps previous snapshots for deeply nested values', async () => {
    const state = createSignal({ user: { name: 'Ada' } });
    const snapshots: string[] = [];

    watch(
      state,
      (_current, previous) => {
        snapshots.push(previous?.user.name ?? '(none)');
      },
      { deep: true }
    );

    state.set({ user: { name: 'Grace' } });
    await flush();
    state.set({ user: { name: 'Lin' } });
    await flush();

    expect(snapshots).toEqual(['Ada', 'Grace']);
  });

  it('accepts a scheduler as the fourth argument', async () => {
    const count = createSignal(0);
    const scheduled: string[] = [];
    const scheduler: Scheduler = {
      scheduleEffect(job) {
        scheduled.push('effect');
        job();
      },
    } as Scheduler;
    let stop: WatchStopHandle;

    stop = watch(
      count,
      (current) => {
        scheduled.push(`value:${current}`);
      },
      { immediate: true },
      scheduler
    );

    count.set(1);
    await flush();

    expect(scheduled).toEqual(['value:0', 'effect', 'value:1']);
    stop();
  });
});
