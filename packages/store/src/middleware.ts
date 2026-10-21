/**
 * 中间件。
 *
 * 设计原则：中间件都是**纯函数包装**，不改变 atom 的读写语义，
 * 只是在 `set` 前后插入一条链路，因此可以任意组合。
 */
import { batch, watch } from '@lania-v/reactivity';
import type { Atom } from './atom';
import { bindStore, getStore, type StoreSnapshot } from './store';

export interface PersistOptions<T> {
  /** 存储 key。 */
  key: string;
  /** 存储实现，默认 `localStorage`。 */
  storage?: StorageLike;
  /** 只持久化部分字段；返回 `undefined` 表示整份持久化。 */
  pick?: (value: T) => unknown;
  /** 反序列化后的合并策略，默认整体替换。 */
  merge?: (persisted: unknown, current: T) => T;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

const resolveStorage = (storage?: StorageLike): StorageLike | null => {
  if (storage) {
    return storage;
  }

  return typeof globalThis.localStorage === 'undefined'
    ? null
    : globalThis.localStorage;
};

/**
 * 持久化中间件。
 *
 * ```ts
 * const settings = persist(createAtom({ theme: 'dark' }), {
 *   key: 'app.settings',
 * });
 * ```
 *
 * - 创建时同步读取一次并写入 atom；
 * - 后续每次写入回写到 storage；
 * - 存储不可用（SSR、隐私模式）时自动降级为纯内存 atom。
 */
export const persist = <T>(
  atom: Atom<T>,
  options: PersistOptions<T>
): Atom<T> => {
  const storage = resolveStorage(options.storage);

  if (!storage) {
    return atom;
  }

  try {
    const raw = storage.getItem(options.key);

    if (raw !== null) {
      const parsed = JSON.parse(raw) as unknown;
      const next = options.merge
        ? options.merge(parsed, atom.peek())
        : (parsed as T);
      atom.set(next);
    }
  } catch {
    // 反序列化失败时保留初始值，不让存储问题阻断应用启动。
  }

  watch(atom, (current) => {
    try {
      const payload = options.pick ? options.pick(current) : current;
      storage.setItem(options.key, JSON.stringify(payload));
    } catch {
      // 写入失败（配额/循环引用）时保持内存状态可用。
    }
  });

  return atom;
};

export interface HistoryOptions {
  /** 历史上限，默认 50。 */
  limit?: number;
}

export interface HistoryControls {
  undo(): void;
  redo(): void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  clear(): void;
}

/**
 * 历史记录中间件：为单个 atom 记录快照，支持 undo / redo。
 *
 * 只记录 `set` 产生的状态，因此派生值不会被重复存储。
 */
export const withHistory = <T>(
  atom: Atom<T>,
  options: HistoryOptions = {}
): HistoryControls => {
  const limit = options.limit ?? 50;
  const past: T[] = [];
  const future: T[] = [];
  let applying = false;

  watch(atom, (current) => {
    if (applying) {
      return;
    }

    past.push(current);

    if (past.length > limit) {
      past.shift();
    }

    future.length = 0;
  });

  const restore = (value: T): void => {
    applying = true;

    try {
      batch(() => atom.set(value));
    } finally {
      applying = false;
    }
  };

  return {
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    undo(): void {
      const previous = past.pop();

      if (previous === undefined) {
        return;
      }

      future.push(atom.peek());
      restore(previous);
    },
    redo(): void {
      const next = future.pop();

      if (next === undefined) {
        return;
      }

      past.push(atom.peek());
      restore(next);
    },
    clear(): void {
      past.length = 0;
      future.length = 0;
    },
  };
};

export interface DevtoolsOptions {
  /** 调试通道名，默认 `lania-store`。 */
  name?: string;
  /** 额外附加的标签。 */
  tags?: Record<string, unknown>;
}

export interface DevtoolsHooks {
  /** 监听 store 快照变化；返回停止函数。 */
  subscribe(
    listener: (snapshot: StoreSnapshot, label: string) => void
  ): () => void;
  /** 主动拍一张快照。 */
  snapshot(label?: string): StoreSnapshot;
}

/**
 * Devtools 中间件：把写入事件投递到全局 hook 上。
 *
 * 只在 `__DEV__` / `NODE_ENV !== 'production'` 下生效，生产环境返回空实现。
 */
export const withDevtools = (options: DevtoolsOptions = {}): DevtoolsHooks => {
  const name = options.name ?? 'lania-store';
  const listeners = new Set<(snapshot: StoreSnapshot, label: string) => void>();
  const store = getStore();
  const enabled = isDevEnvironment();

  const emit = (label: string): void => {
    if (!enabled || listeners.size === 0) {
      return;
    }

    const snapshot = store.snapshot();
    const hook = (
      globalThis as { __LANIA_STORE_DEVTOOLS__?: (payload: unknown) => void }
    ).__LANIA_STORE_DEVTOOLS__;

    hook?.({ name, label, tags: options.tags, snapshot });

    for (const listener of [...listeners]) {
      listener(snapshot, label);
    }
  };

  return {
    subscribe(listener) {
      if (!enabled) {
        return () => undefined;
      }

      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot(label = 'snapshot') {
      emit(label);
      return store.snapshot();
    },
  };
};

const isDevEnvironment = (): boolean => {
  const flag = (
    globalThis as {
      __LANIA_DEV__?: boolean;
      process?: { env?: { NODE_ENV?: string } };
    }
  ).__LANIA_DEV__;

  if (typeof flag === 'boolean') {
    return flag;
  }

  const nodeEnv = (globalThis as { process?: { env?: { NODE_ENV?: string } } })
    .process?.env?.NODE_ENV;

  return nodeEnv !== 'production';
};

/** 便捷：在指定 store 内执行一次快照读取。 */
export const snapshotIn = (run: () => StoreSnapshot): StoreSnapshot =>
  bindStore(run)();
