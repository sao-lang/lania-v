/**
 * 基于 Proxy 的细粒度 store 实现。
 *
 * 这套 store 的目标不是深度代理后自动收集所有依赖，而是把“读取路径”和“路径版本号”
 * 关联起来，让编译产物或运行时辅助函数可以精确订阅某个字段路径：
 * - 读取时通过 `trackExactPath` 触碰对应路径的版本 signal
 * - 写入时通过 `notifyPathMutation` 通知受影响的祖先/后代路径
 * - 代理对象本身会按路径缓存，避免重复创建 Proxy
 *
 * 这样既保留了对象式访问体验，也避免了完整 diff 或隐式依赖跟踪的复杂度。
 */
import { createSignal, type Signal } from './signal';
import { defaultScheduler, type Scheduler } from './scheduler';

export type StorePathSegment = string | number | symbol;
export type StoreUpdater<T> = T | ((previous: T) => T);
export type StorePathUpdater = unknown | ((previous: unknown) => unknown);
export type StoreSetter<T> = {
  /** 整体替换 store。 */
  (value: StoreUpdater<T>): T;
  /** 点路径写入：`set('user.name', 'Grace')`。 */
  (path: string, value: StorePathUpdater): T;
  /** 分段路径写入：`set('user', 'name', 'Grace')`。 */
  (...pathAndValue: [...StorePathSegment[], StorePathUpdater]): T;
};

/**
 * `createStore()` 的返回句柄：保留对象式响应式读取，同时提供与 `createSignal()`
 * 一致的 `set` / `peek` 方法。
 *
 * `set` 与 `peek` 是保留字段，store 数据里不要使用同名属性。
 */
export type Store<T extends object> = T & {
  set: StoreSetter<T>;
  peek: () => T;
};

// 仅供编译产物和内部工具读取 store runtime，用户侧不应依赖这个 symbol。
const STORE_RUNTIME_SYMBOL: unique symbol = Symbol('lania-store-runtime');

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
  pathCache: Map<string, unknown>;
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
  ensureVersionSignal(runtime, path)();
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

const createStoreProxy = <T>(
  runtime: StoreRuntime<T>,
  path: readonly StorePathSegment[] = []
): T => {
  const cacheKey = pathKey(path);
  const cached = runtime.pathCache.get(cacheKey);

  if (cached) {
    return cached as T;
  }

  const target = Array.isArray(readPath(runtime.source.peek(), path)) ? [] : {};

  const proxy = new Proxy(target, {
    get(_target, property) {
      if (property === STORE_RUNTIME_SYMBOL) {
        return runtime;
      }
      if (path.length === 0) {
        // 根句柄暴露与 createSignal 一致的 set / peek，读写入口不再需要元组解构。
        if (property === 'set') {
          return runtime.set;
        }
        if (property === 'peek') {
          return runtime.peek;
        }
      }
      if (property === '__raw') {
        // 提供一个显式逃生口，允许内部逻辑读取当前路径的原始值。
        trackExactPath(runtime, path);
        return readPath(runtime.source.peek(), path);
      }

      const nextPath = [...path, property];
      const value = readPath(runtime.source.peek(), nextPath);

      if (typeof value === 'function') {
        // 方法调用时把 owner 绑定回当前对象路径，避免 `this` 丢失。
        return bindCallableValue(runtime, value, path);
      }

      if (isObjectLike(value) || Array.isArray(value)) {
        // 嵌套对象继续延迟代理，只有真正访问到对应路径时才创建 Proxy。
        return createStoreProxy(runtime, nextPath);
      }

      trackExactPath(runtime, nextPath);
      return value;
    },
    has(_target, property) {
      trackExactPath(runtime, path);
      const value = readPath(runtime.source.peek(), path);
      return isObjectLike(value) || Array.isArray(value)
        ? property in (value as object)
        : false;
    },
    ownKeys() {
      trackExactPath(runtime, path);
      const value = readPath(runtime.source.peek(), path);
      return isObjectLike(value) || Array.isArray(value)
        ? Reflect.ownKeys(value as object)
        : [];
    },
    getOwnPropertyDescriptor(target, property) {
      trackExactPath(runtime, path);
      const value = readPath(runtime.source.peek(), path);
      const targetDescriptor = Reflect.getOwnPropertyDescriptor(target, property);

      if ((isObjectLike(value) || Array.isArray(value)) && property in (value as object)) {
        // 数组的 `length` 等属性在代理 target 上本来就是不可配置的，
        // 必须保持同样的描述符形状，否则会触发 Proxy 不变量错误。
        if (targetDescriptor && !targetDescriptor.configurable) {
          return {
            ...targetDescriptor,
            value: (value as Record<PropertyKey, unknown>)[property],
          };
        }

        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: (value as Record<PropertyKey, unknown>)[property],
        };
      }

      return targetDescriptor;
    },
  }) as T;

  runtime.pathCache.set(cacheKey, proxy);
  return proxy;
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
  // 三个及以上参数保持分段路径语义：`set('user', 'name', 'Grace')`。
  if (args.length === 2 && typeof first === 'string') {
    return {
      path: parseStorePathString(first),
      value: args[1],
    };
  }

  return {
    path: args.slice(0, -1) as StorePathSegment[],
    value: args[args.length - 1],
  };
};

export const createStore = <T extends object>(
  initialValue: T,
  scheduler: Scheduler = defaultScheduler
): Store<T> => {
  const signal = createSignal<T>(initialValue, scheduler);
  const runtime: StoreRuntime<T> = {
    source: signal,
    versionSignals: new Map(),
    pathCache: new Map(),
    scheduler,
    set: undefined as unknown as StoreSetter<T>,
    peek: () => signal.peek(),
  };
  const store = createStoreProxy<T>(runtime);

  const setStore = ((...args: unknown[]) => {
    const { path, value } = resolveSetterArgs(args);
    const next =
      path.length === 0
        ? signal.set(value as StoreUpdater<T>)
        : signal.set((previous) => applyPathUpdate(previous, path, value) as T);
    notifyPathMutation(runtime, path);
    return next;
  }) as StoreSetter<T>;

  runtime.set = setStore;

  return store as Store<T>;
};

const cloneForProduce = <T>(value: T): T => {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // 包含函数/类实例等不可克隆值时退回浅拷贝。
    }
  }

  if (Array.isArray(value)) {
    return [...value] as T;
  }

  if (isObjectLike(value)) {
    return { ...value } as T;
  }

  return value;
};

/**
 * 以可变写法更新 store。
 *
 * ```ts
 * const state = createStore({ list: [] as number[] });
 * produce(state, (draft) => { draft.list.push(1); });
 * ```
 *
 * 只有在数据可被 `structuredClone` 时才是真正的深拷贝；含函数/类实例时退回浅拷贝，
 * 此时请优先使用 `state.set('path.to.value', next)` 的路径写法。
 */
export const produce = <T extends object>(
  store: Store<T>,
  recipe: (draft: T) => void
): T => {
  return store.set((previous) => {
    const draft = cloneForProduce(previous);
    recipe(draft);
    return draft;
  });
};

export const getStorePathSignal = (
  store: unknown,
  path: readonly StorePathSegment[]
): Signal<number> => {
  const runtime = (store as Record<PropertyKey, unknown> | null)?.[
    STORE_RUNTIME_SYMBOL as unknown as PropertyKey
  ] as StoreRuntime<any> | undefined;

  if (!runtime) {
    throw new Error('getStorePathSignal() expects a store proxy returned by createStore().');
  }

  // 若该路径此前没人订阅，则在这里按需创建版本 signal。
  return ensureVersionSignal(runtime, path);
};
