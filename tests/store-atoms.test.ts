import { beforeEach, describe, expect, it } from 'vitest';

import {
  bindStore,
  createAction,
  createAtom,
  createAtomFamily,
  createDerivedAtom,
  createStore,
  getRootStore,
  getStore,
  resetRootStore,
  runWithStore,
} from '@lania-v/store';
import { createEffect, createScope, watch } from '@lania-v/runtime/reactivity';

const flush = async (times = 3): Promise<void> => {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
};

beforeEach(() => {
  resetRootStore();
});

describe('createAtom', () => {
  it('reads and writes like a signal', () => {
    const count = createAtom(0);

    expect(count.value).toBe(0);
    count.set(1);
    expect(count.value).toBe(1);
    count.set((previous) => previous + 1);
    expect(count.peek()).toBe(2);
  });

  it('returns the atom itself so set calls can chain', () => {
    const form = createAtom({ account: '', password: '', remember: false });

    const returned = form
      .set('account', 'ada')
      .set('password', 'secret')
      .set('remember', true);

    expect(returned).toBe(form);
    expect(form.value).toEqual({
      account: 'ada',
      password: 'secret',
      remember: true,
    });
  });

  it('supports dot paths, array paths and segmented paths', () => {
    const state = createAtom({
      user: { name: 'Ada', age: 20 },
      todos: [{ title: 'write docs' }],
    });

    state.set('user.name', 'Grace');
    state.set(['user', 'age'], 21);
    state.set('todos', 0, { title: 'ship code' });
    state.set('todos.0.title', 'ship it');

    expect(state.value.user.name).toBe('Grace');
    expect(state.value.user.age).toBe(21);
    expect(state.value.todos[0]?.title).toBe('ship it');
  });

  it('updates immutably along the changed path', () => {
    const state = createAtom({ user: { name: 'Ada' }, page: 1 });
    const before = state.peek();

    state.set('user.name', 'Grace');

    // 写入后原快照保持不变，新快照只替换变更链路上的容器。
    expect(state.peek()).not.toBe(before);
    expect(before.user.name).toBe('Ada');
    expect(state.peek().page).toBe(1);
  });

  it('resets to the initial value', () => {
    const count = createAtom(5);

    count.set(9);
    count.reset();

    expect(count.value).toBe(5);
  });

  it('skips notification when the value is unchanged', async () => {
    const count = createAtom(1);
    const seen: number[] = [];

    createEffect(() => {
      seen.push(count.value);
    });

    count.set(1);
    await flush();

    expect(seen).toEqual([1]);
  });
});

describe('deep reactivity', () => {
  it('tracks nested object reads by path', async () => {
    const state = createAtom({ user: { name: 'Ada', age: 20 }, page: 1 });
    const names: string[] = [];
    const ages: number[] = [];

    createEffect(() => {
      names.push(state.value.user.name);
    });
    createEffect(() => {
      ages.push(state.value.user.age);
    });

    state.set('user.name', 'Grace');
    await flush();

    expect(names).toEqual(['Ada', 'Grace']);
    // age 未变化，不应重复执行（effect 首轮只跑一次）。
    expect(ages.length).toBe(1);
  });

  it('invalidates descendants when a parent object is replaced', async () => {
    const state = createAtom({ user: { name: 'Ada', age: 20 } });
    const seen: string[] = [];

    createEffect(() => {
      seen.push(`${state.value.user.name}:${state.value.user.age}`);
    });

    state.set('user', { name: 'Grace', age: 21 });
    await flush();

    expect(seen).toEqual(['Ada:20', 'Grace:21']);
  });
});

describe('watch integration', () => {
  it('watches an atom like a signal', async () => {
    const count = createAtom(0);
    const seen: Array<[number, number]> = [];

    watch(count, (current, previous) => {
      seen.push([current, previous]);
    });

    count.set(1);
    await flush();

    expect(seen).toEqual([[1, 0]]);
  });

  it('watches only the selected path inside an object atom', async () => {
    const form = createAtom({ status: 'idle', account: '' });
    const seen: string[] = [];

    watch(
      () => form.value.status,
      (current) => {
        seen.push(current);
      }
    );

    form.set('account', 'ada');
    await flush();
    form.set('status', 'submitting');
    await flush();

    expect(seen).toEqual(['submitting']);
  });
});

describe('derived atoms', () => {
  it('recomputes when dependencies change', async () => {
    const price = createAtom(100);
    const count = createAtom(2);
    const total = createDerivedAtom(() => price.value * count.value);

    expect(total.value).toBe(200);

    count.set(3);
    await flush();

    expect(total.value).toBe(300);
  });

  it('supports writable derived atoms', async () => {
    const count = createAtom(2);
    const doubled = createDerivedAtom(
      () => count.value * 2,
      (next: number) => {
        count.set(next / 2);
      }
    );

    doubled.set(10);
    await flush();

    // 写函数写的是源 atom；派生值是同步刷新的缓存，应立即反映新状态。
    expect(count.value).toBe(5);
    expect(doubled.value).toBe(10);
  });

  it('memoizes derived reads between invalidations', () => {
    const count = createAtom(1);
    let runs = 0;
    const doubled = createDerivedAtom(() => {
      runs += 1;
      return count.value * 2;
    });

    void doubled.value;
    const afterFirst = runs;
    void doubled.value;
    void doubled.value;

    // 依赖不变时重复读取不会重新计算。
    expect(runs).toBe(afterFirst);
  });
});

describe('actions', () => {
  it('batches multiple writes into one wave', async () => {
    const count = createAtom(0);
    const effects: number[] = [];

    createEffect(() => {
      effects.push(count.value);
    });

    const bump = createAction((by: number) => {
      count.set((value) => value + by);
      count.set((value) => value + by);
    });

    bump(2);
    await flush();

    expect(count.value).toBe(4);
    expect(effects).toEqual([0, 4]);
  });
});

describe('atom family', () => {
  it('returns a stable identity per key', () => {
    const todos = createAtom([{ id: 'a', text: 'one' }]);
    const todoOf = createAtomFamily((id: string) =>
      createDerivedAtom(
        () => todos.value.find((todo) => todo.id === id) ?? null
      )
    );

    expect(todoOf('a')).toBe(todoOf('a'));
    expect(todoOf('a').value?.text).toBe('one');
    expect(todoOf('b').value).toBeNull();
  });
});

describe('store scopes', () => {
  it('falls back to the root store outside any scope', () => {
    const count = createAtom(0);

    expect(getStore()).toBe(getRootStore());
    expect(count.value).toBe(0);
  });

  it('isolates atoms created inside a scope', () => {
    const isolated = createStore();
    const insideCount = runWithStore(isolated, () => createAtom(0));

    insideCount.set(7);

    expect(insideCount.value).toBe(7);
    expect(Object.keys(isolated.snapshot())).toHaveLength(1);
    expect(Object.keys(getRootStore().snapshot())).toHaveLength(0);
  });

  it('binds the current store to async callbacks', async () => {
    const isolated = createStore();
    const count = runWithStore(isolated, () => createAtom(0));
    const writeLater = bindStore(() => count.set(3));

    await flush();
    writeLater();

    expect(count.value).toBe(3);
    expect(isolated.snapshot()[count.atomKey]).toBe(3);
  });

  it('restores state from a snapshot', () => {
    const isolated = createStore();
    const count = runWithStore(isolated, () => createAtom(1, { key: 'count' }));
    const label = runWithStore(isolated, () =>
      createAtom('a', { key: 'label' })
    );

    count.set(9);
    label.set('b');
    const snapshot = isolated.snapshot();

    count.set(0);
    label.set('');
    isolated.hydrate(snapshot);

    expect(count.value).toBe(9);
    expect(label.value).toBe('b');
  });

  it('keeps derived atoms out of snapshots', () => {
    const isolated = createStore();

    runWithStore(isolated, () => {
      const count = createAtom(2, { key: 'count' });
      createDerivedAtom(() => count.value * 2, { key: 'doubled' });
    });

    expect(isolated.snapshot()).toEqual({ count: 2 });
  });
});

describe('scope cleanup', () => {
  it('disposes effects created inside a scope', async () => {
    const count = createAtom(0);
    const seen: number[] = [];
    const scope = createScope(() => {
      createEffect(() => {
        seen.push(count.value);
      });
    });

    scope.dispose();
    count.set(1);
    await flush();

    expect(seen).toEqual([0]);
  });
});
