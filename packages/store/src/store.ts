/**
 * Store 作用域（scope）。
 *
 * `@lania/store` 的 atom 本身就是 Signal，所以“这一段代码读写哪一份状态”由
 * 同步执行上下文栈决定，而不是隐式树形派发：
 *
 * - 没有显式作用域时，所有 atom 落到模块级默认 store；
 * - `createStore()` 建一份独立 store，`runWithStore()` 在同步调用链内切换；
 * - `bindStore()` 把当前 store 固定到回调上，供异步边界使用。
 *
 * 因此组件内外写法完全一致：`atom.value` / `atom.set(...)`。
 */
import { batch } from '@lania-v/runtime';

export interface StoreAtomRecord {
  readonly atomId: number;
  /** 快照使用的稳定 key。 */
  readonly atomKey: string;
  readonly atomKind: 'atom' | 'derived';
  readonly peek: () => unknown;
  /** 无校验写入，仅供 hydrate 使用。 */
  readonly setRaw: (value: unknown) => void;
}

export type StoreSnapshot = Record<string, unknown>;

export interface Store {
  /** 读某个 atom 在当前 store 里的值。 */
  get<T>(atom: { readonly atomId: number; peek: () => T }): T;
  /** 写某个 atom；返回 store 自身，便于链式。 */
  set<T>(
    atom: { readonly atomId: number; setRaw: (value: T) => void },
    value: T
  ): Store;
  /** 显式注册 atom（`createStore` 内创建 atom 时用）。 */
  register(record: StoreAtomRecord): void;
  /** 只序列化可写 atom 的当前值。 */
  snapshot(): StoreSnapshot;
  /** 从快照恢复；未知 key 会被忽略。 */
  hydrate(snapshot: StoreSnapshot): void;
  /** 释放 store 内登记的状态。 */
  dispose(): void;
  /** 内部记录表，供调试与 devtools 枚举。 */
  readonly records: ReadonlyMap<number, StoreAtomRecord>;
}

let nextAtomId = 1;
let nextAnonymousKey = 1;

const storeStack: Store[] = [];

export const nextStoreAtomId = (): number => nextAtomId++;

export const createAnonymousKey = (): string => `atom_${nextAnonymousKey++}`;

const createStoreInstance = (): Store => {
  const records = new Map<number, StoreAtomRecord>();
  const keyIndex = new Map<string, number>();

  const store: Store = {
    records,
    register(record) {
      if (!records.has(record.atomId)) {
        records.set(record.atomId, record);
      }

      if (!keyIndex.has(record.atomKey)) {
        keyIndex.set(record.atomKey, record.atomId);
      }
    },
    get(atom) {
      return atom.peek();
    },
    set(atom, value) {
      atom.setRaw(value);
      return store;
    },
    snapshot() {
      const snapshot: StoreSnapshot = {};

      for (const record of records.values()) {
        // 派生 atom 由源状态重算，不进入快照。
        if (record.atomKind === 'derived') {
          continue;
        }

        snapshot[record.atomKey] = record.peek();
      }

      return snapshot;
    },
    hydrate(next) {
      batch(() => {
        for (const [key, value] of Object.entries(next)) {
          const atomId = keyIndex.get(key);

          if (atomId === undefined) {
            continue;
          }

          const record = records.get(atomId);

          if (!record || record.atomKind === 'derived') {
            continue;
          }

          record.setRaw(value);
        }
      });
    },
    dispose() {
      records.clear();
      keyIndex.clear();
    },
  };

  return store;
};

export const createStore = (): Store => createStoreInstance();

/** 默认 store 的惰性单例。 */
let rootStore: Store | null = null;

export const getRootStore = (): Store => {
  if (!rootStore) {
    rootStore = createStoreInstance();
  }

  return rootStore;
};

/** 当前执行上下文对应的 store；栈为空时回落默认 store。 */
export const getStore = (): Store =>
  storeStack[storeStack.length - 1] ?? getRootStore();

/**
 * 在指定 store 内同步执行 `run`。
 *
 * 支持嵌套；`run` 抛错时也会恢复外层上下文。
 */
export const runWithStore = <R>(store: Store, run: () => R): R => {
  storeStack.push(store);

  try {
    return run();
  } finally {
    storeStack.pop();
  }
};

/**
 * 把当前 store 固定到回调上，供异步边界使用。
 *
 * ```ts
 * const save = bindStore((text: string) => addTodo(text));
 * setTimeout(() => save('later'), 100); // 仍写回原 store
 * ```
 */
export const bindStore = <A extends unknown[], R>(
  run: (...args: A) => R
): ((...args: A) => R) => {
  const captured = getStore();
  return (...args: A) => runWithStore(captured, () => run(...args));
};

/** 重置默认 store（主要供测试使用）。 */
export const resetRootStore = (): void => {
  rootStore?.dispose();
  rootStore = null;
};

/** 当前是否处于显式 store 上下文。 */
export const hasExplicitStore = (): boolean => storeStack.length > 0;
