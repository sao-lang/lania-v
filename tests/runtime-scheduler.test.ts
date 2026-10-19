import { describe, expect, it } from 'vitest';

import {
  HIGH,
  LOW,
  Scheduler,
  createDoubleBufferState,
  defaultScheduler,
  schedule,
  scheduleIdle,
  tick,
  supportsRequestIdleCallback,
} from '@lania-v/runtime';

const flushMicrotasks = async (times = 1): Promise<void> => {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
};

describe('Scheduler', () => {
  it('dedupes the same job in one microtask', async () => {
    const scheduler = new Scheduler();
    let calls = 0;
    const job = () => {
      calls += 1;
    };

    scheduler.schedule(job);
    scheduler.schedule(job);
    await flushMicrotasks();

    expect(calls).toBe(1);
  });

  it('flushes once after batch completes', async () => {
    const scheduler = new Scheduler();
    const calls: string[] = [];

    scheduler.batch(() => {
      scheduler.schedule(() => {
        calls.push('first');
      });
      scheduler.schedule(() => {
        calls.push('second');
      });
    });

    expect(calls).toEqual([]);
    await flushMicrotasks();
    expect(calls).toEqual(['first', 'second']);
  });

  it('drains jobs scheduled during an active flush', async () => {
    const scheduler = new Scheduler();
    const calls: string[] = [];

    scheduler.schedule(() => {
      calls.push('outer');
      scheduler.schedule(() => {
        calls.push('inner');
      });
    });

    await flushMicrotasks();

    expect(calls).toEqual(['outer', 'inner']);
  });

  it('runs higher priority jobs before lower priority jobs', async () => {
    const scheduler = new Scheduler();
    const calls: string[] = [];

    scheduler.schedule(() => {
      calls.push('low');
    }, LOW);
    scheduler.schedule(() => {
      calls.push('high');
    }, HIGH);

    await flushMicrotasks();

    expect(calls).toEqual(['high', 'low']);
  });

  it('flushes lifecycle jobs before effect tail jobs', async () => {
    const scheduler = new Scheduler();
    const calls: string[] = [];

    scheduler.scheduleLifecycle(() => {
      calls.push('lifecycle');
    });
    scheduler.scheduleEffect(() => {
      calls.push('effect');
    });

    await flushMicrotasks();

    expect(calls).toEqual(['lifecycle', 'effect']);
  });

  it('waits for the current scheduler flush with tick', async () => {
    const scheduler = new Scheduler();
    const calls: string[] = [];

    const flushed = scheduler.tick();
    scheduler.schedule(() => {
      calls.push('job');
    });

    await flushed;

    expect(calls).toEqual(['job']);
  });

  it('exposes a default scheduler tick helper', async () => {
    const calls: string[] = [];

    schedule(() => {
      calls.push('default');
    });

    await tick();

    expect(calls).toEqual(['default']);
  });

  it('supports low-priority transitions', async () => {
    const calls: string[] = [];

    await defaultScheduler.createTransition(() => {
      calls.push('transition');
      return 'done';
    });
    await flushMicrotasks();

    expect(calls).toEqual(['transition']);
  });

  it('supports double-buffer state commit', () => {
    const state = createDoubleBufferState({ count: 0 });

    state.update((current) => ({
      count: current.count + 1,
    }));

    expect(state.current.count).toBe(0);
    expect(state.pending.count).toBe(1);
    expect(state.commit().count).toBe(1);
    expect(state.current.count).toBe(1);
  });

  it('slices unit of work with message channel scheduling', async () => {
    const scheduler = new Scheduler();
    let steps = 0;

    scheduler.scheduleUnitOfWork({
      run: () => {
        steps += 1;
        return steps >= 2;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(steps).toBe(2);
  });

  it('exposes requestIdleCallback capability and idle scheduling fallback', async () => {
    const calls: string[] = [];

    expect(supportsRequestIdleCallback()).toBe(false);

    scheduleIdle(() => {
      calls.push('idle');
    });
    await flushMicrotasks();

    expect(calls).toEqual(['idle']);
  });
});
