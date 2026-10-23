/**
 * 原子（atom）。
 *
 * 设计目标：
 * - **语法 signal-like**：`atom.value` 读取、`atom.set(...)` 写入，和 `createSignal()` 手感一致；
 * - **语义 jotai-like**：atom 是稳定的身份对象，可组合派生 atom 与动作；
 * - **深度响应**：对象/数组 atom 复用 `createSignal` 的路径视图，
 *   `user.value.profile.city` 只订阅 `['profile', 'city']`；
 * - **链式 set**：`atom.set('a', 1).set('b', 2)` 返回 atom 自身。
 */
import {
  batch,
  createMemo,
  createSignal,
  untrack,
  watch,
  type ReadonlySignal,
  type Signal,
} from '@lania-v/runtime/reactivity';
import {
  createAnonymousKey,
  getStore,
  nextStoreAtomId,
  type Store,
} from './store';

export type AtomPathSegment = string | number;
export type AtomUpdater<T> = T | ((previous: T) => T);
export type AtomPathUpdater = unknown | ((previous: unknown) => unknown);

/** `atom.set` 的重载集合：整体替换 / 点路径 / 数组路径 / 分段路径；返回值都是 atom 自身。 */
export type AtomSetter<T> = {
  (value: AtomUpdater<T>): Atom<T>;
  (path: string, value: AtomPathUpdater): Atom<T>;
  (path: readonly AtomPathSegment[], value: AtomPathUpdater): Atom<T>;
  (...pathAndValue: [...AtomPathSegment[], AtomPathUpdater]): Atom<T>;
};

export interface AtomOptions<T> {
  /** 快照 / 持久化使用的稳定 key；缺省时自动生成。 */
  key?: string;
  /** 持久化钩子：创建时读取一次，之后每次写入回写。 */
  persist?: {
    read: () => T | undefined;
    write: (value: T) => void;
  };
  /** 自定义等值判断，默认 `Object.is`。 */
  equals?: (previous: T, next: T) => boolean;
}

export interface DerivedAtomOptions {
  /** 调试用 key；派生 atom 不进入快照。 */
  key?: string;
}

export type Atom<T> = {
  /** 响应式读取；对象类型返回路径级只读视图。 */
  readonly value: T;
  /** 写入并返回 atom 自身，支持链式调用。 */
  readonly set: AtomSetter<T>;
  /** 不建立订阅的快照读取。 */
  readonly peek: () => T;
  /** 恢复到创建时的初始值。 */
  readonly reset: () => Atom<T>;
  readonly updaters: Set<() => void>;
  /** 稳定的原子身份 id。 */
  readonly atomId: number;
  /** 快照使用的稳定 key。 */
  readonly atomKey: string;
  readonly atomKind: 'atom';
  readonly atomInitial: T;
};

export type DerivedAtom<T> = {
  readonly value: T;
  readonly peek: () => T;
  readonly updaters: Set<() => void>;
  readonly atomId: number;
  readonly atomKind: 'derived';
};

export type WritableDerivedAtom<T, Args extends unknown[]> = DerivedAtom<T> & {
  readonly set: (...args: Args) => void;
};

const isObjectLike = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === 'object' && value !== null;

/** 沿路径浅拷贝的不可变更新：只重建变更链路上的容器。 */
const applyPath = (
  current: unknown,
  path: readonly AtomPathSegment[],
  next: AtomPathUpdater
): unknown => {
  if (path.length === 0) {
    return typeof next === 'function'
      ? (next as (previous: unknown) => unknown)(current)
      : next;
  }

  const [head, ...tail] = path;
  const base: Record<PropertyKey, unknown> | unknown[] = Array.isArray(current)
    ? [...current]
    : isObjectLike(current)
      ? { ...current }
      : {};
  (base as Record<PropertyKey, unknown>)[head] = applyPath(
    (current as Record<PropertyKey, unknown> | undefined)?.[head],
    tail,
    next
  );
  return base;
};

const parsePathString = (path: string): AtomPathSegment[] => {
  const segments = path.split('.');

  if (segments.some((segment) => segment.length === 0)) {
    throw new TypeError(`atom.set() received an invalid path: "${path}"`);
  }

  return segments.map((segment) =>
    /^-?\d+$/.test(segment) ? Number(segment) : segment
  );
};

const resolveSetterArgs = (
  args: readonly unknown[]
): { path: AtomPathSegment[] | null; value: AtomPathUpdater } => {
  if (args.length === 1) {
    // 单参数一律整体替换；回调按“上一份完整值”处理。
    return { path: null, value: args[0] as AtomPathUpdater };
  }

  const [first] = args;

  if (args.length === 2 && typeof first === 'string') {
    return { path: parsePathString(first), value: args[1] as AtomPathUpdater };
  }

  if (args.length === 2 && Array.isArray(first)) {
    const path = first as AtomPathSegment[];

    if (path.length === 0) {
      throw new TypeError('atom.set() received an empty path array.');
    }

    return { path, value: args[1] as AtomPathUpdater };
  }

  return {
    path: args.slice(0, -1) as AtomPathSegment[],
    value: args[args.length - 1] as AtomPathUpdater,
  };
};

/**
 * 创建一个原子。
 *
 * ```ts
 * const count = createAtom(0);
 * const user = createAtom({ name: 'Ada' }, { key: 'user' });
 *
 * count.value;                       // 0
 * count.set(1).set(2);               // 链式写入
 * user.set('profile.city', 'Lyon');  // 路径写入
 * ```
 */
export const createAtom = <T>(
  initialValue: T,
  options: AtomOptions<T> = {}
): Atom<T> => {
  const store: Store = getStore();
  const persisted = options.persist?.read();
  const startValue = (persisted === undefined ? initialValue : persisted) as T;
  const signal: Signal<T> = createSignal<T>(startValue);
  const atomId = nextStoreAtomId();
  const atomKey = options.key ?? createAnonymousKey();
  const equals = options.equals ?? Object.is;
  const writePersist = options.persist?.write;

  const commit = (
    next: T,
    changedPath: readonly AtomPathSegment[] = []
  ): void => {
    // 用 peek 取原始树：`signal.value` 返回冻结视图，不适合再参与下一次计算。
    const previous = signal.peek();

    if (equals(previous, next)) {
      return;
    }

    // 有路径时按该路径精确通知；整树替换时传空路径，唤醒全部已注册路径。
    signal.setValueWithPath(next, changedPath);
    writePersist?.(signal.peek());
  };

  const atom: Atom<T> = {
    atomId,
    atomKey,
    atomKind: 'atom',
    atomInitial: startValue,
    get value() {
      return signal.value;
    },
    peek: () => signal.peek(),
    updaters: signal.updaters,
    set: ((...args: unknown[]) => {
      const { path, value } = resolveSetterArgs(args);

      if (path === null) {
        const previous = signal.peek();
        commit(
          typeof value === 'function'
            ? (value as (prev: T) => T)(previous)
            : (value as T)
        );
      } else {
        commit(applyPath(signal.peek(), path, value) as T, path);
      }

      return atom;
    }) as AtomSetter<T>,
    reset: () => {
      commit(startValue);
      return atom;
    },
  };

  store.register({
    atomId,
    atomKey,
    atomKind: 'atom',
    peek: () => signal.peek(),
    // 整体替换：空路径表示整棵树都变了，所有订阅者都会收到通知。
    setRaw: (next: unknown) => {
      signal.setValueWithPath(next as T, []);
      writePersist?.(signal.peek());
    },
  });

  return atom;
};

/**
 * 派生原子：读函数自动建立依赖，写函数可选。
 *
 * ```ts
 * const total = createDerivedAtom(() => price.value * count.value);
 * const doubled = createDerivedAtom(
 *   () => count.value * 2,
 *   (next: number) => count.set(next / 2)
 * );
 * ```
 *
 * 实现上由 `createMemo` 承担缓存与依赖追踪；写函数执行后会同步刷新 memo，
 * 保证同一 tick 内读到最新派生值。
 */
export function createDerivedAtom<T>(
  read: () => T,
  options?: DerivedAtomOptions
): DerivedAtom<T>;
export function createDerivedAtom<T, Args extends unknown[]>(
  read: () => T,
  write: (...args: Args) => void,
  options?: DerivedAtomOptions
): WritableDerivedAtom<T, Args>;
export function createDerivedAtom<T, Args extends unknown[]>(
  read: () => T,
  writeOrOptions?: ((...args: Args) => void) | DerivedAtomOptions,
  maybeOptions?: DerivedAtomOptions
): DerivedAtom<T> | WritableDerivedAtom<T, Args> {
  const write =
    typeof writeOrOptions === 'function' ? writeOrOptions : undefined;
  const options =
    (typeof writeOrOptions === 'function' ? maybeOptions : writeOrOptions) ??
    {};
  const store = getStore();
  const atomId = nextStoreAtomId();
  const memo: ReadonlySignal<T> = createMemo(read);

  const base: DerivedAtom<T> = {
    atomId,
    atomKind: 'derived',
    get value() {
      return memo.value;
    },
    peek: () => memo.peek(),
    updaters: memo.updaters,
  };

  store.register({
    atomId,
    atomKey: options.key ?? createAnonymousKey(),
    atomKind: 'derived',
    peek: () => memo.peek(),
    setRaw: () => {
      throw new TypeError(
        'Derived atoms are read-only; update their source atoms instead.'
      );
    },
  });

  if (!write) {
    return base;
  }

  // 可写派生 atom 额外持有一个缓存 signal：
  // 写函数改的是源 atom，但 memo 的重算走调度队列，同一 tick 内读取会拿到旧值。
  // 因此写完成后把最新派生值同步进 cache，读路径始终走 cache，语义保持同步。
  const cache: Signal<T> = createSignal<T>(untrack(read));

  const syncCache = (): void => {
    cache.setValue(memo.peek());
  };

  memo.updaters.add(syncCache);

  return {
    atomId,
    atomKind: 'derived',
    get value() {
      void memo.value;
      return cache.value;
    },
    peek: () => cache.peek(),
    updaters: cache.updaters,
    set: (...args: Args) => {
      // 写函数内部可能多次 set 源 atom，合并成一次提交。
      batch(() => write(...args));
      // 写函数改的是源 atom，派生缓存必须立刻对齐（memo 重算走调度队列，会滞后）。
      cache.setValue(untrack(read));
    },
  };
}

/**
 * 动作：把一组写入包成一次批量提交。
 *
 * ```ts
 * const addTodo = createAction((text: string) => {
 *   todos.set((prev) => [...prev, { id: uid(), text, done: false }]);
 *   draft.set('');
 * });
 * ```
 */
export const createAction = <Args extends unknown[], R = void>(
  run: (...args: Args) => R
): ((...args: Args) => R) => {
  return (...args: Args) => batch(() => run(...args));
};

/**
 * 原子族：按 key 缓存原子，保证同一个 key 拿到同一个身份。
 *
 * ```ts
 * const todoOf = createAtomFamily((id: string) =>
 *   createDerivedAtom(() => todos.value.find((todo) => todo.id === id) ?? null)
 * );
 * ```
 */
export const createAtomFamily = <K, A>(
  factory: (key: K) => A
): ((key: K) => A) => {
  const cache = new Map<K, A>();

  return (key: K) => {
    const existing = cache.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const created = factory(key);
    cache.set(key, created);
    return created;
  };
};

/**
 * 在 atom 变化时执行副作用（等价 `watch`，但只接受 atom 句柄）。
 *
 * 返回停止函数，并自动挂到当前 owner 上。
 */
export const watchAtom = <T>(
  atom: { readonly value: T; peek: () => T; updaters: Set<() => void> },
  listener: (next: T, previous: T) => void
): (() => void) => {
  let initialized = false;
  let previous = atom.peek();

  return watch(atom, (current: T) => {
    if (!initialized) {
      initialized = true;
      previous = current;
      return;
    }

    if (!Object.is(current, previous)) {
      const last = previous;
      previous = current;
      listener(current, last);
    }
  });
};
