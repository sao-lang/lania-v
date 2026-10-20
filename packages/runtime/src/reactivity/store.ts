/**
 * 细粒度响应式 store。
 *
 * 这里刻意不使用 Proxy：
 * - 每个“访问过的路径”都有一个版本 signal，读取时只触碰该路径，写入时通知受影响的祖先/后代路径；
 * - 子对象同样是只读视图，因此任意深度的 `state.user.name` 都能精确订阅，而不需要真实代理；
 * - 属性在类型与运行时都是只读的，任何 `state.x = v` 都会抛错，写入只有 `set()` 一条路。
 */
import { createSignal, type ReadonlySignal, type Signal } from './signal';
import { createMemo, watch } from './signal';
import { defaultScheduler, type Scheduler } from './scheduler';

export type StorePathSegment = string | number | symbol;
export type StoreUpdater<T> = T | ((previous: T) => T);
export type StorePathUpdater = unknown | ((previous: unknown) => unknown);
export type StoreSetter<T> = {
  /** 整体替换 store（对象参数不再合并）。 */
  (value: StoreUpdater<T>): T;
  /** 点路径写入：`set('user.name', 'Grace')`。 */
  (path: string, value: StorePathUpdater): T;
  /** 数组路径写入：`set(['user', 'name'], 'Grace')`。 */
  (path: readonly StorePathSegment[], value: StorePathUpdater): T;
  /** 分段路径写入：`set('user', 'name', 'Grace')`。 */
  (...pathAndValue: [...StorePathSegment[], StorePathUpdater]): T;
};

/**
 * `createStore()` 的返回句柄。
 *
 * 属性是只读视图：`state.user.name` 只用于读取并建立订阅；
 * 修改状态必须调用 `set()` 系列方法，`peek()` 用于不建立订阅的快照读取。
 *
 * `set` / `peek` / `get` / `update` / `delete` / `patch` / `reset` / `subscribe` /
 * `derive` / `keys` / `entries` / `has` 是保留字段，store 数据里不要使用同名属性。
 */
export type Store<T extends object> = Readonly<T> & {
  set: StoreSetter<T>;
  peek: () => T;
  /** 按路径读取单个值（支持动态路径）。 */
  get: (path: string | readonly StorePathSegment[]) => unknown;
  /** 路径是否存在。 */
  has: (path: string | readonly StorePathSegment[]) => boolean;
  /** 浅层键名快照。 */
  keys: () => string[];
  /** `[key, value]` 快照。 */
  entries: () => Array<[string, unknown]>;
  /** 语义化路径更新，回调必须返回新值。 */
  update: (path: string | readonly StorePathSegment[], updater: (previous: unknown) => unknown) => T;
  /** 删除路径。 */
  delete: (path: string | readonly StorePathSegment[]) => T;
  /** 显式浅合并（`set` 是整体替换）。 */
  patch: (partial: Partial<T>) => T;
  /** 恢复到创建时的初始值。 */
  reset: () => T;
  /** 订阅变化；传入路径时只订阅该路径。返回取消订阅函数。 */
  subscribe: {
    (listener: (state: T, previous: T) => void): () => void;
    (path: string | readonly StorePathSegment[], listener: (next: unknown, previous: unknown) => void): () => void;
  };
  /** 从 store 派生一个只读 memo。 */
  derive: <R>(compute: () => R) => ReadonlySignal<R>;
};

// 只读视图内部需要拿回 store runtime，这里用闭包映射而不是在对象上挂 symbol，
// 避免把内部实现细节暴露成可枚举/可伪造的属性。
const storeRuntimes = new WeakMap<object, StoreRuntime<any>>();

const isObjectLike = (value: unknown): value is Record<PropertyKey, unknown> => {
  return typeof value === 'object' && value !== null;
};

const pathKey = (path: readonly StorePathSegment[]): string => {
  // 数字下标与字符串下标在读代理和点路径写法中会以不同形态出现，
  // 这里统一成字符串，保证二者订阅到同一个版本 signal。
  // symbol 不能直接稳定地 JSON 序列化，这里先编码成显式对象结构。
  return JSON.stringify(
    path.map((segment) => {
      if (typeof segment === 'symbol') {
        return { type: 'symbol', value: String(segment) };
      }

      return { type: 'string', value: String(segment) };
    })
  );
};

const normalizePath = (path: readonly StorePathSegment[]): StorePathSegment[] => {
  return path.map((segment) => (typeof segment === 'number' ? String(segment) : segment));
};

const isPrefixPath = (
  candidate: readonly StorePathSegment[],
  target: readonly StorePathSegment[]
): boolean => {
  return (
    candidate.length <= target.length &&
    candidate.every((segment, index) => Object.is(segment, target[index]))
  );
};

const readPath = (value: unknown, path: readonly StorePathSegment[]): unknown => {
  return path.reduce<unknown>((current, segment) => {
    if (!isObjectLike(current) && !Array.isArray(current)) {
      return undefined;
    }

    return (current as Record<PropertyKey, unknown>)[segment];
  }, value);
};

const cloneContainer = (value: unknown): Record<PropertyKey, unknown> | unknown[] => {
  if (Array.isArray(value)) {
    return [...value];
  }

  if (isObjectLike(value)) {
    return { ...value };
  }

  return {};
};

const applyPathUpdate = (
  current: unknown,
  path: readonly StorePathSegment[],
  nextValue: unknown | ((previous: unknown) => unknown)
): unknown => {
  if (path.length === 0) {
    return typeof nextValue === 'function'
      ? (nextValue as (previous: unknown) => unknown)(current)
      : nextValue;
  }

  const [head, ...tail] = path;
  // 采用“沿路径逐层浅拷贝”的不可变更新策略，只重建变更链路上的容器。
  const base = cloneContainer(current);
  const previousChild = (base as Record<PropertyKey, unknown>)[head];
  const nextChild = applyPathUpdate(previousChild, tail, nextValue);
  (base as Record<PropertyKey, unknown>)[head] = nextChild;
  return base;
};

interface StoreRuntime<T> {
  source: Signal<T>;
  versionSignals: Map<string, Signal<number>>;
  viewCache: Map<string, unknown>;
  scheduler: Scheduler;
  set: StoreSetter<T>;
  peek: () => T;
}

const ensureVersionSignal = (
  runtime: StoreRuntime<any>,
  path: readonly StorePathSegment[]
): Signal<number> => {
  const key = pathKey(path);
  const existing = runtime.versionSignals.get(key);

  if (existing) {
    return existing;
  }

  const next = createSignal(0, runtime.scheduler);
  runtime.versionSignals.set(key, next);
  return next;
};

const trackExactPath = (
  runtime: StoreRuntime<any>,
  path: readonly StorePathSegment[]
): void => {
  // 读取 `.value` 即可建立依赖收集。
  void ensureVersionSignal(runtime, path).value;
};

const notifyPathMutation = (
  runtime: StoreRuntime<any>,
  changedPath: readonly StorePathSegment[]
): void => {
  const normalizedChangedPath = normalizePath(changedPath);

  for (const [key, signal] of runtime.versionSignals.entries()) {
    const decoded = JSON.parse(key) as Array<{ type: string; value: string }>;
    const registeredPath = decoded.map((entry) => {
      if (entry.type === 'number') {
        return Number(entry.value);
      }

      return entry.value;
    });

    if (
      isPrefixPath(registeredPath, normalizedChangedPath) ||
      isPrefixPath(normalizedChangedPath, registeredPath)
    ) {
      // 祖先路径和后代路径都视为受影响，例如改 `user.name` 也会影响 `user`。
      signal.set((value) => value + 1);
    }
  }
};

const bindCallableValue = (
  runtime: StoreRuntime<any>,
  value: Function,
  ownerPath: readonly StorePathSegment[]
): Function => {
  trackExactPath(runtime, ownerPath);
  const owner = readPath(runtime.source.peek(), ownerPath);
  return value.bind(owner);
};

const describePath = (path: readonly StorePathSegment[]): string =>
  path.length === 0 ? 'store' : `store.${path.map(String).join('.')}`;

const createReadonlyError = (
  path: readonly StorePathSegment[],
  property: PropertyKey
): TypeError => {
  const target = [...path, property];
  const writablePath = target.map(String).join('.');
  return new TypeError(
    `${describePath(target)} is read-only. Use store.set(${JSON.stringify(writablePath)}, value) to update the store.`
  );
};

// 深层只读视图：每次属性访问都按路径实时读取 store，并按路径精确订阅。
// 视图本身按路径缓存，因此 `state.user === state.user` 成立，且不会重复建订阅。

// 数组视图上会改变内容的原方法一律拒绝，读取/遍历类方法按当前快照执行。
const ARRAY_READONLY_METHODS = new Set<PropertyKey>([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
]);

const createStoreView = <T>(
  runtime: StoreRuntime<T>,
  path: readonly StorePathSegment[] = [],
  extraAccessors: Record<PropertyKey, unknown> = {}
): T => {
  const cacheKey = pathKey(path);
  const cached = runtime.viewCache.get(cacheKey);

  if (cached) {
    return cached as T;
  }

  // 根视图额外暴露 set / peek 等方法；更深层的视图只保留数据字段。
  // 每个条目是「读取该访问器」的 getter，`get` trap 调用一次得到最终值。
  const rootAccessors: Record<PropertyKey, () => unknown> =
    path.length === 0
      ? {
          set: () => runtime.set,
          peek: () => runtime.peek,
          ...extraAccessors,
        }
      : {};

  const assertReadonly = (property: PropertyKey): never => {
    throw createReadonlyError(path, property);
  };

  const view = new Proxy(
    // 数组视图用数组做 Proxy target，`Array.isArray` 与快照断言才能识别它是数组。
    Array.isArray(readPath(runtime.source.peek(), path)) ? [] : {},
    {
      get(_target, property) {
        if (path.length === 0 && Object.hasOwn(rootAccessors, property)) {
          return rootAccessors[property]!();
        }

        if (property === '__raw') {
          // 显式逃生口：读取当前路径原始值，仍然建立订阅。
          trackExactPath(runtime, path);
          return readPath(runtime.source.peek(), path);
        }

        // 数组视图需要保持“像数组”的语义：长度、迭代器与内建方法都要可用。
        if (typeof property === 'symbol') {
          trackExactPath(runtime, path);
          const current = readPath(runtime.source.peek(), path);
          return Array.isArray(current)
            ? (Array.prototype as unknown as Record<PropertyKey, unknown>)[property]
            : undefined;
        }

        if (Array.isArray(readPath(runtime.source.peek(), path)) && ARRAY_READONLY_METHODS.has(property)) {
          // 视图是只读的，数组变更方法要么合成一个只读副本再执行（返回副本），
          // 要么直接报错，避免“改了但没生效”的静默错误。
          throw createReadonlyError(path, property);
        }

        if (Array.isArray(readPath(runtime.source.peek(), path)) && typeof (Array.prototype as unknown as Record<string, unknown>)[property] === 'function') {
          trackExactPath(runtime, path);
          const current = readPath(runtime.source.peek(), path) as unknown[];
          return (...methodArgs: unknown[]) =>
            (Array.prototype as unknown as Record<string, Function>)[property].apply(current, methodArgs);
        }

        const nextPath = [...path, property];
        const value = readPath(runtime.source.peek(), nextPath);

        if (typeof value === 'function') {
          // 方法调用时把 owner 绑定回当前对象路径，避免 `this` 丢失。
          return bindCallableValue(runtime, value, path);
        }

        if (isObjectLike(value) || Array.isArray(value)) {
          // 子对象继续返回只读视图，实现任意深度的路径级订阅。
          return createStoreView(runtime, nextPath);
        }

        trackExactPath(runtime, nextPath);
        return value;
      },
      set(_target, property) {
        return assertReadonly(property);
      },
      deleteProperty(_target, property) {
        return assertReadonly(property);
      },
      defineProperty(_target, property) {
        return assertReadonly(property);
      },
      has(_target, property) {
        if (typeof property === 'symbol') {
          return false;
        }

        trackExactPath(runtime, path);
        const value = readPath(runtime.source.peek(), path);
        return isObjectLike(value) || Array.isArray(value)
          ? property in (value as object)
          : false;
      },
      ownKeys() {
        trackExactPath(runtime, path);
        const value = readPath(runtime.source.peek(), path);
        return isObjectLike(value) || Array.isArray(value) ? Reflect.ownKeys(value as object) : [];
      },
      getOwnPropertyDescriptor(_target, property) {
        if (typeof property === 'symbol') {
          return undefined;
        }

        trackExactPath(runtime, path);
        const value = readPath(runtime.source.peek(), path);

        if (Array.isArray(value) && property === 'length') {
          // 数组 target 上的 `length` 是不可配置属性，描述符形状必须与之一致。
          return {
            configurable: false,
            enumerable: false,
            value: value.length,
            writable: true,
          };
        }

        if (!(isObjectLike(value) || Array.isArray(value)) || !(property in (value as object))) {
          // 根视图要额外声明 set / peek，否则 `'set' in state` 与 Object.keys 会对不上。
          if (path.length === 0 && Object.hasOwn(rootAccessors, property)) {
            return { configurable: true, enumerable: false, value: undefined, writable: false };
          }

          return undefined;
        }

        return {
          configurable: true,
          // 视图字段一律不可写，避免通过 descriptor 绕过只读约束。
          enumerable: true,
          // 数组 target 上的索引属性不可配置，描述符必须保持一致。
          writable: Array.isArray(value),
          value: (value as Record<PropertyKey, unknown>)[property],
        };
      },
      getPrototypeOf() {
        return Array.isArray(readPath(runtime.source.peek(), path))
          ? Array.prototype
          : Object.prototype;
      },
    }
  ) as T;

  // 根视图之外仍需能反查 runtime（供 getStorePathSignal 使用）。
  storeRuntimes.set(view as object, runtime);
  runtime.viewCache.set(cacheKey, view);
  return view;
};

const parseStorePathString = (path: string): StorePathSegment[] => {
  const segments = path.split('.');

  if (segments.some((segment) => segment.length === 0)) {
    throw new TypeError(`createStore().set() received an invalid path: "${path}"`);
  }

  return segments;
};

const resolveSetterArgs = (
  args: readonly unknown[]
): { path: StorePathSegment[]; value: unknown } => {
  if (args.length === 1) {
    return { path: [], value: args[0] };
  }

  const [first] = args;

  // 两个参数且首参为字符串时按点路径解析：`set('user.name', 'Grace')`。
  if (args.length === 2 && typeof first === 'string') {
    return {
      path: parseStorePathString(first),
      value: args[1],
    };
  }

  // 两个参数且首参是数组时按分段路径解析：`set(['user', 'name'], 'Grace')`。
  if (args.length === 2 && Array.isArray(first)) {
    const path = first as StorePathSegment[];

    if (path.length === 0) {
      throw new TypeError('createStore().set() received an empty path array.');
    }

    return { path, value: args[1] };
  }

  return {
    path: args.slice(0, -1) as StorePathSegment[],
    value: args[args.length - 1],
  };
};

const resolvePath = (path: string | readonly StorePathSegment[]): StorePathSegment[] =>
  typeof path === 'string' ? parseStorePathString(path) : [...path];

export const createStore = <T extends object>(
  initialValue: T,
  scheduler: Scheduler = defaultScheduler
): Store<T> => {
  const signal = createSignal<T>(initialValue, scheduler);
  // 初始值单独留存，供 `reset()` 恢复；深拷贝避免后续写入污染初始快照。
  const initialState = deepClone(initialValue);
  const runtime: StoreRuntime<T> = {
    source: signal,
    versionSignals: new Map(),
    viewCache: new Map(),
    scheduler,
    set: undefined as unknown as StoreSetter<T>,
    peek: () => signal.peek(),
  };

  const replace = (value: StoreUpdater<T>): T => {
    const next = signal.set(value);
    // 整体替换会影响所有路径，空路径即“整棵树都变了”。
    notifyPathMutation(runtime, []);
    return next;
  };

  // 先装配 set，再创建视图：根视图的访问器在首次读取时必须已经就绪。
  const setStore = ((...args: unknown[]) => {
    if (args.length === 1) {
      // 单参数一律整体替换；嵌套字段请用路径写法。
      return replace(args[0] as StoreUpdater<T>);
    }

    const { path, value } = resolveSetterArgs(args);
    const next = signal.set((previous) => applyPathUpdate(previous, path, value) as T);
    notifyPathMutation(runtime, path);
    return next;
  }) as StoreSetter<T>;

  runtime.set = setStore;

  // 这些方法是“注入到根视图上的访问器”，不写进视图对象本身，
  // 因此不会触发只读拦截，也不会污染 Object.keys(state) 的数据字段列表。
  let store: Store<T>;
  const handlers: Record<PropertyKey, () => unknown> = {
    get: () => (path: string | readonly StorePathSegment[]) =>
      readPath(signal.peek(), resolvePath(path)),
    has: () => (path: string | readonly StorePathSegment[]) =>
      readPath(signal.peek(), resolvePath(path)) !== undefined,
    keys: () => () => {
      const current = signal.peek();
      return isObjectLike(current) ? Object.keys(current) : [];
    },
    entries: () => () => {
      const current = signal.peek();
      return isObjectLike(current) ? Object.entries(current) : [];
    },
    update: () => (path: string | readonly StorePathSegment[], updater: (previous: unknown) => unknown) => {
      const segments = resolvePath(path);
      const next = signal.set(
        (previous) => applyPathUpdate(previous, segments, (value: unknown) => updater(value)) as T
      );
      notifyPathMutation(runtime, segments);
      return next;
    },
    delete: () => (path: string | readonly StorePathSegment[]) => {
      const segments = resolvePath(path);

      if (segments.length === 0) {
        throw new TypeError('store.delete() expects a non-empty path.');
      }

      const next = signal.set((previous) => removePath(previous, segments) as T);
      notifyPathMutation(runtime, segments);
      return next;
    },
    patch: () => (partial: Partial<T>) => {
      const next = signal.set((previous) => ({ ...previous, ...partial }) as T);
      // 合并只影响补丁里出现的字段，按字段通知即可保持精确订阅。
      for (const key of Reflect.ownKeys(partial as object)) {
        notifyPathMutation(runtime, [key]);
      }
      return next;
    },
    reset: () => () => replace(deepClone(initialState)),
    subscribe: () =>
      (
        pathOrListener: string | readonly StorePathSegment[] | ((state: T, previous: T) => void),
        maybeListener?: (next: unknown, previous: unknown) => void
      ) => {
        if (typeof pathOrListener === 'function') {
          const listener = pathOrListener;
          let initialized = false;

          return watch(signal, (current, previous) => {
            // 首次回调只是建立订阅，不算变化。
            if (!initialized) {
              initialized = true;
              return;
            }

            listener(current, previous);
          });
        }

        const segments = resolvePath(pathOrListener);
        const listener = maybeListener!;
        return watch(
          getStorePathSignal(store, segments) as unknown as Signal<number>,
          () => listener(readPath(signal.peek(), segments), undefined)
        );
      },
    derive: () => <R>(compute: () => R): ReadonlySignal<R> => createMemo(compute, scheduler),
  };

  store = createStoreView<T>(runtime, [], handlers) as unknown as Store<T>;
  return store;
};

/** 深拷贝：优先 structuredClone，含不可克隆值时退回浅拷贝。 */
const deepClone = <T>(value: T): T => {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // 含函数/类实例时退回浅拷贝。
    }
  }

  if (Array.isArray(value)) {
    return [...value] as T;
  }

  return isObjectLike(value) ? ({ ...value } as T) : value;
};

/** 删除路径上的键；路径不存在时保持原状。 */
const removePath = (current: unknown, path: readonly StorePathSegment[]): unknown => {
  const [head, ...tail] = path;

  if (tail.length === 0) {
    if (Array.isArray(current)) {
      const next = [...current];
      next.splice(Number(head), 1);
      return next;
    }

    if (!isObjectLike(current)) {
      return current;
    }

    const next = { ...current };
    delete next[head as string];
    return next;
  }

  if (!isObjectLike(current) && !Array.isArray(current)) {
    return current;
  }

  const base: Record<PropertyKey, unknown> | unknown[] = Array.isArray(current)
    ? [...current]
    : { ...(current as Record<PropertyKey, unknown>) };
  (base as Record<PropertyKey, unknown>)[head as string] = removePath(
    (current as Record<PropertyKey, unknown>)[head as string],
    tail
  );
  return base;
};

/**
 * 用纯函数计算下一个状态。
 *
 * ```ts
 * const state = createStore({ count: 0, list: [] as number[] });
 * produce(state, (draft) => ({ ...draft, count: draft.count + 1 }));
 * ```
 *
 * - `draft` 是当前状态的**只读**快照，回调内不能改写它；
 * - 回调是纯函数：必须有返回值，且只能依据 `draft` 计算结果；
 * - 返回值作为新状态整体写回（`createStore` 的 `set` 不做合并）。
 */
export const produce = <T extends object>(
  store: Store<T>,
  recipe: (draft: T) => T
): T => {
  const runtime = storeRuntimes.get(store as object) as StoreRuntime<T> | undefined;

  if (!runtime) {
    throw new Error('produce() expects a store returned by createStore().');
  }

  // draft 是同一份只读视图：属性读取照常建立订阅，写入会被只读约束拦下。
  const draft = createStoreView<T>(runtime) as T;
  const next = recipe(draft);

  if (!isObjectLike(next)) {
    throw new TypeError('produce() expects the recipe to return the next state object.');
  }

  return store.set(next);
};

export const getStorePathSignal = (
  store: unknown,
  path: readonly StorePathSegment[]
): Signal<number> => {
  const runtime =
    store && (typeof store === 'object' || typeof store === 'function')
      ? storeRuntimes.get(store as object)
      : undefined;

  if (!runtime) {
    throw new Error('getStorePathSignal() expects a store returned by createStore().');
  }

  // 若该路径此前没人订阅，则在这里按需创建版本 signal。
  return ensureVersionSignal(runtime, path);
};
