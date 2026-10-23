import { describe, expect, it } from 'vitest';

import { createSignal, watch } from '@lania-v/runtime';
import { createAtom } from '@lania-v/store';

const flush = async (times = 3): Promise<void> => {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
};

describe('watch getter sources', () => {
  it('accepts a getter that returns a signal-bearing expression', async () => {
    const count = createSignal(0);
    const events: Array<[number, number | undefined]> = [];

    watch(
      () => count.value,
      (current, previous) => {
        events.push([current, previous]);
      }
    );

    count.set(1);
    await flush();
    expect(events).toEqual([[1, 0]]);
  });

  it('subscribes to a single store path without firing on sibling fields', async () => {
    const form = createAtom({ status: 'idle', account: '' });
    const events: string[] = [];

    watch(
      () => form.value.status,
      (current) => {
        events.push(current);
      }
    );

    // 写另一个字段不应触发对 status 的监听。
    form.set('account', 'alice');
    await flush();
    expect(events).toEqual([]);

    form.set('status', 'submitting');
    await flush();
    expect(events).toEqual(['submitting']);

    form.set('status', 'submitting');
    await flush();
    expect(events).toEqual(['submitting']);
  });

  it('tracks a whole store object when the getter returns it', async () => {
    const form = createAtom({ status: 'idle', account: '' });
    const seen: Array<{ status: string; account: string }> = [];

    watch(
      () => ({ status: form.value.status, account: form.value.account }),
      (current) => {
        seen.push(current);
      }
    );

    form.set('account', 'bob');
    await flush();
    expect(seen).toEqual([{ status: 'idle', account: 'bob' }]);

    form.set('status', 'error');
    await flush();
    expect(seen).toEqual([
      { status: 'idle', account: 'bob' },
      { status: 'error', account: 'bob' },
    ]);
  });

  it('resubscribes when the getter switches branches', async () => {
    const flag = createSignal(true);
    const left = createSignal('L');
    const right = createSignal('R');
    const events: string[] = [];

    watch(
      () => (flag.value ? left.value : right.value),
      (current) => {
        events.push(current);
      }
    );

    // 初始走 left 分支，改 right 不应触发。
    right.set('R2');
    await flush();
    expect(events).toEqual([]);

    flag.set(false);
    await flush();
    expect(events).toEqual(['R2']);

    // 切到 right 分支后，left 的变化不再触发，right 的才触发。
    left.set('L2');
    await flush();
    expect(events).toEqual(['R2']);

    right.set('R3');
    await flush();
    expect(events).toEqual(['R2', 'R3']);
  });

  it('stops watching a getter after the stop handle runs', async () => {
    const count = createSignal(0);
    const events: number[] = [];

    const stop = watch(
      () => count.value,
      (current) => {
        events.push(current);
      }
    );

    count.set(1);
    await flush();
    stop();

    count.set(2);
    await flush();
    expect(events).toEqual([1]);
  });
});
