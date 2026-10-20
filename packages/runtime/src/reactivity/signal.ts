import {
  defaultScheduler,
  getSignalPriority,
  type Job,
  type Scheduler,
} from './scheduler';
import { onOwnerCleanup } from './owner';
import { emitSignalDebugEvent, isDevEnvironment } from '../core/debug';

/**
 * 响应式 Signal 实现（类似 Solid 的 signal / memo / effect 思路）。
 *
 * 设计要点：
 * - `Signal<T>` 是一个“可调用的 getter”，并在对象上挂载 `set/peek/updaters`；
 * - 依赖收集通过 `trackingStack` 实现：读取 signal 时把当前 signal 加入“正在收集”的集合；
 * - 派生与副作用（memo/effect/watch）通过把 job 绑定到 deps 的 `updaters` 集合实现；
 * - 调度交给 `Scheduler`：signal.set 不直接同步跑 job，而是按优先级排队。
 */

export type SignalSetter<T> = {
  /** 整体替换 signal 的值。 */
  (value: T | ((prev: T) => T)): T;
  /** 点路径写入对象型 signal：`user.set('profile.city', 'Lyon')`。 */
  (path: string, value: unknown | ((prev: unknown) => unknown)): T;
};

const readPathValue = (value: unknown, path: readonly (string | number)[]): unknown => {
  return path.reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }

    return (current as Record<string | number, unknown>)[segment];
  }, value);
};

/**
 * 深层只读视图的通用构造器。
 *
 * 与 store 的实现保持一致：视图按路径严格读取当前值，并把「当前路径」登记为一个订阅点，
 * 因此 `sig.value.user.name` 只订阅 `['user', 'name']`，兄弟字段变化不会重跑。
 * 视图本身按路径缓存（由调用方维护 cache），保证 `sig.value.user === sig.value.user`。
 */
export interface PathViewRuntime<T> {
  /** 读取当前整棵状态（不建立路径订阅）。 */
  readRoot: () => T;
  /** 订阅某个路径；读取视图属性时调用。 */
  trackPath: (path: readonly (string | number)[]) => void;
  /** 只读写入错误信息。 */
  describeReadonly: (path: readonly (string | number)[], property: PropertyKey) => string;
  /** 视图缓存：同一路径必须返回同一实例。 */
  cache: Map<string, unknown>;
  /** 按路径读取后的值转换（例如冻结）。 */
  transformLeaf?: (value: unknown) => unknown;
}

const ARRAY_MUTATORS = new Set<PropertyKey>([
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

const createPathView = (
  runtime: PathViewRuntime<unknown>,
  path: readonly (string | number)[] = []
): unknown => {
  const key = path.join('\u0000');
  const cached = runtime.cache.get(key);

  if (cached) {
    return cached;
  }

  const current = readPathValue(runtime.readRoot(), path);

  // 原始值直接返回；对象/数组才需要视图。
  if (current === null || typeof current !== 'object') {
    runtime.cache.set(key, current);
    return current;
  }

  // target 必须是空对象/空数组：所有读写都通过 trap 转发到当前状态，
  // 否则真实对象作为 target 时会触发 Proxy 的“描述符必须一致”不变量。
  const target = Array.isArray(current) ? [] : {};

  const view = new Proxy(target, {
    get(_target, property) {
      const raw = readPathValue(runtime.readRoot(), path);

      if (typeof property === 'symbol') {
        // 数组迭代器 / 内建符号按数组原型解析，保持 `for...of` 与展开语义。
        // 迭代结果必须是当前真实元素，因此先把快照转成普通数组再迭代。
        if (property === Symbol.iterator) {
          const snapshot = Array.isArray(raw) ? [...raw] : null;
          return snapshot ? snapshot[Symbol.iterator].bind(snapshot) : undefined;
        }

        const proto = Array.isArray(raw) ? Array.prototype : Object.prototype;
        return Reflect.get(proto, property);
      }

      if (Array.isArray(raw) && ARRAY_MUTATORS.has(property)) {
        throw new TypeError(runtime.describeReadonly(path, property));
      }

      const nextPath = [...path, property];
      runtime.trackPath(nextPath);

      const nextValue = readPathValue(runtime.readRoot(), nextPath);

      if (typeof nextValue === 'function') {
        // 方法调用时把 owner 绑定回当前对象，避免 `this` 丢失。
        const owner = readPathValue(runtime.readRoot(), path);
        return (nextValue as Function).bind(owner);
      }

      if (nextValue !== null && typeof nextValue === 'object') {
        return createPathView(runtime, nextPath);
      }

      return runtime.transformLeaf ? runtime.transformLeaf(nextValue) : nextValue;
    },
    set(_target, property) {
      throw new TypeError(runtime.describeReadonly(path, property));
    },
    deleteProperty(_target, property) {
      throw new TypeError(runtime.describeReadonly(path, property));
    },
    defineProperty(_target, property) {
      throw new TypeError(runtime.describeReadonly(path, property));
    },
    has(_target, property) {
      runtime.trackPath(path);
      const raw = readPathValue(runtime.readRoot(), path);
      return raw !== null && typeof raw === 'object' ? property in (raw as object) : false;
    },
    ownKeys() {
      runtime.trackPath(path);
      const raw = readPathValue(runtime.readRoot(), path);
      return raw !== null && typeof raw === 'object' ? Reflect.ownKeys(raw as object) : [];
    },
    getOwnPropertyDescriptor(_target, property) {
      if (typeof property === 'symbol') {
        return undefined;
      }

      const raw = readPathValue(runtime.readRoot(), path);

      if (Array.isArray(raw) && property === 'length') {
        // 数组 target 上的 length 不可配置，描述符形状必须一致。
        return { configurable: false, enumerable: false, value: raw.length, writable: true };
      }

      if (raw === null || typeof raw !== 'object' || !(property in (raw as object))) {
        // 属性不存在时不建立路径订阅：`Object.keys` / 展开 / 描述符探测本身
        // 不应把整棵子树变成依赖，否则兄弟字段变化会误触发重算。
        return undefined;
      }

      // 只订阅被真正访问到的属性路径，保持与 `get` 一致的精确度。
      runtime.trackPath([...path, property as string]);

      return {
        configurable: true,
        enumerable: true,
        // 数组索引在数组 target 上不可配置，必须声明为可写以匹配不变量。
        writable: Array.isArray(raw),
        value: (raw as Record<PropertyKey, unknown>)[property],
      };
    },
    getPrototypeOf() {
      return Array.isArray(readPathValue(runtime.readRoot(), path))
        ? Array.prototype
        : Object.prototype;
    },
  });

  runtime.cache.set(key, view);
  return view;
};

/**
 * 递归冻结对象/数组，得到不带 Proxy 的只读值。
 *
 * 不用 Proxy 的原因：Proxy 会让每次读取产生新引用，破坏 memo/watch 依赖的 `Object.is` 等值语义；
 * 冻结会一次性把属性改成不可写，读取仍返回同一个对象，因此引用稳定、subscriber 判断正常。
 * 冻结结果按原对象缓存，同一份底层值的多次读取返回同一个只读实例。
 */
const readonlyCache = new WeakMap<object, object>();

const freezeDeep = <T>(value: T): T => {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const target = value as object;
  const cached = readonlyCache.get(target);

  if (cached) {
    return cached as T;
  }

  // 先登记再递归，避免环状引用导致无限递归。
  // 已冻结（外部传入）的对象同样登记，保证后续读取命中同一实例。
  readonlyCache.set(target, target);

  if (!Object.isExtensible(target)) {
    return target as T;
  }

  for (const key of Reflect.ownKeys(target)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);

    if (descriptor && 'value' in descriptor) {
      freezeDeep(descriptor.value as unknown);
    }
  }

  return Object.freeze(target) as T;
};

/** 读取 signal 值时返回只读副本；原始值直接返回。 */
const toReadonlyValue = <T>(value: T): T => freezeDeep(value);

const applyPathValue = (
  current: unknown,
  path: readonly (string | number)[],
  nextValue: unknown
): unknown => {
  if (path.length === 0) {
    return nextValue;
  }

  const [head, ...tail] = path;
  const base = (
    Array.isArray(current)
      ? [...current]
      : current && typeof current === 'object'
        ? { ...(current as Record<string, unknown>) }
        : {}
  ) as Record<string | number, unknown>;

  base[head] = applyPathValue(base[head], tail, nextValue);
  return base;
};

export type SignalSource<T> = Signal<T> | ReadonlySignal<T>;

/**
 * `watch` 接受的源：既可以是 signal 对象，也可以是返回值的 getter。
 *
 * getter 形式（`watch(() => store.status, cb)`）会在每次重算时重新收集依赖，
 * 因此可以自然表达 `store.a` 这种路径读取，不需要额外的路径 API。
 */
export type WatchSource<T> = SignalSource<T> | (() => T);


export type ReadonlySignal<T> = {
  readonly value: T;
  peek: () => T;
  updaters: Set<Job>;
};

export type ComputedAccessor<T> = {
  readonly value: T;
  peek: () => T;
};
export type EffectCleanup = void | (() => void);
export type EffectCallback = () => EffectCleanup;
export type WatchStopHandle = () => void;
export interface DeferredOptions {
  timeoutMs?: number;
}

/** `watch()` 的选项，与 Vue 的 `watch` 保持同一套命名。 */
export interface WatchOptions {
  /** 创建时立即用当前值执行一次回调，此时 `previous` 为 `undefined`。 */
  immediate?: boolean;
  /**
   * 按值比较新旧快照：内容没有变化时不触发回调。
   * `previous` 会是上一次快照的深拷贝，因此可以安全地和 `current` 做逐层比较。
   */
  deep?: boolean;
}

/**
 * `watch()` 回调。
 *
 * `immediate: true` 时首次执行的 `previous` 一定是 `undefined`，
 * 因此这里用 `Immediate` 把该信息带到类型层，普通场景仍然拿到 `T`。
 */
export type WatchCallback<T, Immediate extends boolean = false> = (
  current: T,
  previous: Immediate extends true ? T | undefined : T
) => void;

// 依赖收集栈：每一层对应一次 trackSignals 的收集上下文
const trackingStack: Array<Set<Signal<any>>> = [];
// 当 updaters 较少时用线性数组更省；超过阈值再构建 indexMap 加速 delete/has
const COMPACT_INDEX_THRESHOLD = 8;

class CompactJobSet<T> implements Iterable<T> {
  private items: T[] = [];
  private indexMap: Map<T, number> | null = null;

  get size(): number {
    return this.items.length;
  }

  private ensureIndexMap(): Map<T, number> | null {
    if (this.items.length < COMPACT_INDEX_THRESHOLD) {
      return this.indexMap;
    }

    if (!this.indexMap) {
      this.indexMap = new Map<T, number>();
      this.items.forEach((item, index) => {
        this.indexMap?.set(item, index);
      });
    }

    return this.indexMap;
  }

  private updateIndexMapFrom(startIndex: number): void {
    if (!this.indexMap) {
      return;
    }

    for (let index = startIndex; index < this.items.length; index += 1) {
      this.indexMap.set(this.items[index]!, index);
    }

    if (this.items.length < COMPACT_INDEX_THRESHOLD) {
      this.indexMap = null;
    }
  }

  add(value: T): this {
    if (this.has(value)) {
      return this;
    }

    this.items.push(value);
    this.ensureIndexMap()?.set(value, this.items.length - 1);
    return this;
  }

  delete(value: T): boolean {
    const indexed = this.indexMap?.get(value);
    const index = indexed ?? this.items.indexOf(value);

    if (index < 0) {
      return false;
    }

    this.items.splice(index, 1);
    this.indexMap?.delete(value);
    this.updateIndexMapFrom(index);
    return true;
  }

  has(value: T): boolean {
    return this.indexMap ? this.indexMap.has(value) : this.items.includes(value);
  }

  clear(): void {
    this.items.length = 0;
    this.indexMap?.clear();
    this.indexMap = null;
  }

  forEach(
    callbackfn: (value: T, value2: T, set: CompactJobSet<T>) => void,
    thisArg?: unknown
  ): void {
    this.items.slice().forEach((value) => {
      callbackfn.call(thisArg, value, value, this);
    });
  }

  values(): IterableIterator<T> {
    return this.items.slice()[Symbol.iterator]();
  }

  keys(): IterableIterator<T> {
    return this.values();
  }

  entries(): IterableIterator<[T, T]> {
    return this.items
      .slice()
      .map((value) => [value, value] as [T, T])[Symbol.iterator]();
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.values();
  }
}

const collectActiveSignal = (signal: Signal<any>): void => {
  trackingStack[trackingStack.length - 1]?.add(signal);
};

/** 统一读取 signal 源：写入依赖收集，返回只读值。 */
const readSource = <T>(source: SignalSource<T>): T => {
  return source.value;
};

// `createMemo/createDeferred` 会把计算结果写回一个 signal，这里统一支持“值”与“惰性函数”两种写法。
const writeSignalValue = <T>(signal: Signal<T>, value: T): T => {
  if (typeof value === 'function') {
    return signal.set((() => value) as (previous: T) => T);
  }

  return signal.set(value);
};

// 把某个 job 绑定到一组 signals 的 updaters 上（即：任何一个 dep 变化都能触发该 job）
const attachJobToSignals = (signals: Iterable<Signal<any>>, job: Job): void => {
  for (const signal of signals) {
    signal.updaters.add(job);
  }
};

// 解绑 job（effect/memo 重新收集 deps 时需要先清理旧 deps）
const detachJobFromSignals = (signals: Iterable<Signal<any>>, job: Job): void => {
  for (const signal of signals) {
    signal.updaters.delete(job);
  }
};

export type Signal<T> = {
  /** 响应式读取；每次访问都会建立依赖。 */
  readonly value: T;
  set: SignalSetter<T>;
  peek: () => T;
  updaters: Set<Job>;
  debugId: number;
  // Sets a raw value even if it's a function/class constructor.
  setValue: (value: T) => T;
  /** 写入整棵新树，但按指定路径做精确通知（供外层状态封装使用）。 */
  setValueWithPath: (value: T, changedPath: readonly (string | number)[]) => T;
};

/** 编译产物里的 computed 字段：可读取、可 peek，但不带 setter。 */

/**
 * 在 `run` 执行期间收集依赖：所有被读取的 signal 会被加入 deps。
 * 返回值包含本次执行结果与 deps 集合。
 */
export const trackSignals = <T>(
  run: () => T
): { value: T; deps: Set<Signal<any>> } => {
  const deps = new Set<Signal<any>>();
  trackingStack.push(deps);

  try {
    return {
      value: run(),
      deps,
    };
  } finally {
    trackingStack.pop();
  }
};

export const linkTrackedSignals = (deps: Iterable<Signal<any>>): void => {
  const active = trackingStack[trackingStack.length - 1];

  if (!active) {
    return;
  }

  for (const signal of deps) {
    active.add(signal);
  }
};

export const isTracking = (): boolean => {
  return trackingStack.length > 0;
};

/**
 * 在不收集依赖的上下文里执行 `run`。
 * 常用于 memo/effect 的初始化计算，避免把“初始化读取”误当成依赖。
 */
export const untrack = <T>(run: () => T): T => {
  if (!isTracking()) {
    return run();
  }

  const active = trackingStack.pop();

  try {
    return run();
  } finally {
    if (active) {
      trackingStack.push(active);
    }
  }
};

let nextSignalDebugId = 1;

export const createSignal = <T>(
  initialValue: T,
  scheduler: Scheduler = defaultScheduler
): Signal<T> => {
  let currentValue = initialValue;
  // 这里返回类型上是 Set<Job>，实际用 CompactJobSet 以优化小集合性能。
  const updaters = new CompactJobSet<Job>() as unknown as Set<Job>;
  // 路径级版本 signal：每条被读取过的路径各有一个版本号，写入时只通知相关路径。
  const pathVersions = new Map<string, Signal<number>>();
  // 只读视图按路径缓存，保证 `sig.value.user === sig.value.user`。
  const viewCache = new Map<string, unknown>();

  const ensurePathVersion = (path: readonly (string | number)[]): Signal<number> => {
    const key = path.join('\u0000');
    const existing = pathVersions.get(key);

    if (existing) {
      return existing;
    }

    const created = createSignal(0, scheduler);
    pathVersions.set(key, created);
    return created;
  };

  const notifyPath = (
    changedPath: readonly (string | number)[],
    previousValue: unknown,
    nextValue: unknown
  ): void => {
    const changed = changedPath.map(String);
    const isPrefix = (short: readonly string[], long: readonly string[]): boolean =>
      short.length <= long.length && short.every((segment, index) => segment === long[index]);

    for (const [key, signal] of pathVersions) {
      const registered = key.length === 0 ? [] : key.split('\u0000');

      // 祖先与后代路径互为影响：改 `user` 要通知 `user.name` 的订阅者，反之亦然。
      if (
        changed.length === 0 ||
        registered.length === 0 ||
        isPrefix(registered, changed) ||
        isPrefix(changed, registered)
      ) {
        // 祖先路径（如根视图）只是“容器整体变了”，若该路径读到的值没变，
        // 就不该唤醒只关心兄弟字段的订阅者，这里按值再裁剪一次。
        if (
          registered.length < changedPath.length &&
          isPrefix(registered, changed) &&
          Object.is(
            readPathValue(previousValue, registered),
            readPathValue(nextValue, registered)
          )
        ) {
          continue;
        }

        signal.set((value) => value + 1);
      }
    }
  };

  const notifyPathVersion = (path: readonly (string | number)[]): void => {
    // 路径级写入只唤醒「该路径自身」与「其后代」，祖先由 notifyPath 统一处理。
    const normalized = path.map(String);
    const isPrefix = (short: readonly string[], long: readonly string[]): boolean =>
      short.length <= long.length && short.every((segment, index) => segment === long[index]);

    for (const [key, signal] of pathVersions) {
      if (key.length === 0) {
        // 根版本用于“整体替换”，路径写入不应唤醒它。
        continue;
      }

      const registered = key.split('\u0000');

      if (isPrefix(normalized, registered)) {
        signal.set((value) => value + 1);
      }
    }
  };

  const viewRuntime: PathViewRuntime<unknown> = {
    readRoot: () => currentValue,
    trackPath: (path) => {
      // 路径订阅是精确的：只触碰该路径的版本号，不再订阅整个 signal。
      void ensurePathVersion(path).value;
    },
    describeReadonly: (path, property) => {
      const target = [...path, property].map(String).join('.');
      return `${target} is read-only. Use signal.set(${JSON.stringify(target)}, value) to update it.`;
    },
    cache: viewCache,
    // 叶子值同样需要冻结，避免通过视图拿到可变引用。
    transformLeaf: toReadonlyValue,
  };

  const trackValue = (): T => {
    if (currentValue !== null && typeof currentValue === 'object') {
      // 对象/数组：按路径订阅（根读取订阅根路径），保证兄弟字段互不干扰。
      return createPathView(viewRuntime, []) as T;
    }

    // 原始值没有路径可细分，直接订阅 signal 本身。
    collectActiveSignal(signalHandle);
    return currentValue;
  };

  const commit = (nextValue: T, changedPath: readonly (string | number)[] = []): T => {
    // 使用 Object.is 确保 NaN 等边界值行为一致
    if (Object.is(currentValue, nextValue)) {
      return toReadonlyValue(currentValue);
    }

    const previousValue = currentValue;
    currentValue = nextValue;

    // 值换了引用后，旧视图里缓存的路径实例不再代表当前树，
    // 清空缓存让后续读取重建视图，避免读到视图构建时的旧快照。
    viewCache.clear();

    if (isDevEnvironment()) {
      emitSignalDebugEvent({
        type: 'set',
        signalId: signalHandle.debugId,
        previous: previousValue,
        current: nextValue,
      });
    }

    // 路径写入只通知受影响的路径；整体替换通知所有路径。
    if (changedPath.length === 0) {
      notifyPath([], previousValue, nextValue);
    } else {
      notifyPathVersion(changedPath);
    }

    // set 只“通知”，具体执行时机交给 scheduler（避免深层嵌套 set 造成同步抖动）
    for (const updater of updaters) {
      scheduler.scheduleSignal(updater, getSignalPriority());
    }

    return toReadonlyValue(currentValue);
  };

  const setSignal = ((...args: unknown[]) => {
    // 两个及以上参数视为路径写入：`sig.set('user.name', v)` / `sig.set(['user','name'], v)`。
    if (args.length > 1) {
      const [first, ...rest] = args;
      const segments: (string | number)[] =
        typeof first === 'string' && rest.length === 1
          ? first.split('.').map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment))
          : Array.isArray(first)
            ? (first as (string | number)[])
            : (args.slice(0, -1) as (string | number)[]);
      const nextValue = rest[rest.length - 1];

      return commit(
        applyPathValue(
          currentValue,
          segments,
          typeof nextValue === 'function'
            ? (nextValue as (previous: unknown) => unknown)(
                readPathValue(currentValue, segments)
              )
            : nextValue
        ) as T,
        segments
      );
    }

    const [first] = args;
    return commit(
      typeof first === 'function'
        ? (first as (prev: T) => T)(currentValue)
        : (first as T)
    );
  }) as SignalSetter<T>;

  // 句柄与读取器分离：`value` 是 getter，每次读取都会建立依赖。
  const signalHandle = {
    get value(): T {
      return trackValue();
    },
    set: setSignal,
    // 供 @lania/store 之类的外层封装使用：写入整棵新树，但按指定路径精确通知。
    setValueWithPath: (nextValue: T, changedPath: readonly (string | number)[]) =>
      commit(nextValue, changedPath),
    peek: () => toReadonlyValue(currentValue),
    updaters,
    debugId: nextSignalDebugId++,
    setValue: (value: T) => commit(value),
    // 兼容旧形态：允许 `sig()` 读取，便于逐步迁移。
    [Symbol.toPrimitive]() {
      return trackValue() as unknown as string;
    },
  } as unknown as Signal<T>;

  const read = signalHandle as Signal<T>;
  void read;

  return signalHandle;
};

/**
 * 创建一个惰性可读句柄：每次调用都重新求值，不参与调度。
 *
 * 编译产物用它承载 `createMemo` 的实例字段语义：
 * 调用 `this.x()` 总能拿到最新派生值，裸引用 `this.x` 得到的对象与 signal 形态一致。
 * 因为不缓存，也不会把调度顺序问题带进组件更新链路。
 */
export const createComputedAccessor = <T>(compute: () => T): ComputedAccessor<T> => {
  return {
    get value(): T {
      return compute();
    },
    peek: () => compute(),
  };
};

export const readonly = <T>(signal: SignalSource<T>): ReadonlySignal<T> => {
  return {
    get value(): T {
      return readSource(signal);
    },
    peek: signal.peek,
    updaters: signal.updaters,
  };
};

/**
 * 创建派生 signal：当依赖变化时自动重新计算。
 * - 初始值使用 untrack(compute) 避免把首次计算放进父级依赖收集里
 * - 之后每次 recompute 都会重新收集 deps 并重绑 updaters
 */
export const createMemo = <T>(
  compute: () => T,
  scheduler: Scheduler = defaultScheduler
): ReadonlySignal<T> => {
  const state = createSignal<T>(untrack(compute), scheduler);
  let deps = new Set<Signal<any>>();

  const recompute = () => {
    detachJobFromSignals(deps, recompute);
    const tracked = trackSignals(compute);
    deps = tracked.deps;
    attachJobToSignals(deps, recompute);
    writeSignalValue(state, tracked.value);
  };

  recompute();
  onOwnerCleanup(() => {
    detachJobFromSignals(deps, recompute);
    deps.clear();
  });
  return readonly(state);
};

export const createEffect = (
  effect: EffectCallback,
  scheduler: Scheduler = defaultScheduler
): WatchStopHandle => {
  let deps = new Set<Signal<any>>();
  let cleanup: (() => void) | undefined;

  const runEffect = () => {
    cleanup?.();
    cleanup = undefined;
    detachJobFromSignals(deps, triggerEffect);

    const tracked = trackSignals(effect);
    deps = tracked.deps;
    attachJobToSignals(deps, triggerEffect);

    if (typeof tracked.value === 'function') {
      cleanup = tracked.value;
    }
  };

  const triggerEffect = () => {
    scheduler.scheduleEffect(runEffect);
  };

  runEffect();

  const stop = () => {
    cleanup?.();
    cleanup = undefined;
    detachJobFromSignals(deps, triggerEffect);
    deps.clear();
  };

  onOwnerCleanup(stop);
  return stop;
};

const isPlainObject = (value: unknown): value is Record<PropertyKey, unknown> => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * `deep: true` 时用于判断快照是否真的发生变化。
 *
 * 只深入普通对象与数组：DOM 节点、Map/Set、类实例这类值一律退回引用比较，
 * 避免在 watch 热路径上做代价不可控的遍历。
 */
const isDeepEqual = (current: unknown, previous: unknown): boolean => {
  if (Object.is(current, previous)) {
    return true;
  }

  if (Array.isArray(current) && Array.isArray(previous)) {
    return (
      current.length === previous.length &&
      current.every((item, index) => isDeepEqual(item, previous[index]))
    );
  }

  if (isPlainObject(current) && isPlainObject(previous)) {
    const currentKeys = Object.keys(current);

    if (currentKeys.length !== Object.keys(previous).length) {
      return false;
    }

    return currentKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(previous, key) &&
        isDeepEqual(current[key], previous[key])
    );
  }

  return false;
};

const cloneWatchSnapshot = <T>(value: T): T => {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // 含函数 / 类实例时退回原引用，此时 deep 只能比较到引用这一层。
    }
  }

  return value;
};

const isSignalLike = (value: unknown): value is ReadonlySignal<unknown> => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  // `updaters` 实际是 CompactJobSet 这类自定义集合，不能用 `instanceof Set` 判定。
  const updaters = (value as { updaters?: unknown }).updaters;
  return (
    typeof (value as ReadonlySignal<unknown>).peek === 'function' &&
    typeof updaters === 'object' &&
    updaters !== null &&
    typeof (updaters as Set<unknown>).add === 'function' &&
    typeof (updaters as Set<unknown>).delete === 'function'
  );
};

/**
 * 把 `watch` 的源归一成“读取 + 订阅”两件事。
 *
 * signal 源直接读 `.value` / `.peek`；getter 源则需要在追踪上下文中执行一次，
 * 才能把 `store.status` 这类路径读取转换为具体的 signal 依赖。
 */
interface NormalizedWatchSource {
  peek: () => unknown;
  subscribe: (job: Job) => void;
  unsubscribe: (job: Job) => void;
  /** getter 源按值去重；signal 源沿用 signal 自身的相等性语义。 */
  valueCompared: boolean;
}

const normalizeWatchSource = (source: WatchSource<unknown>): NormalizedWatchSource => {
  if (isSignalLike(source)) {
    const signal = source as Signal<unknown>;
    return {
      peek: () => signal.peek(),
      subscribe: (job) => signal.updaters.add(job),
      unsubscribe: (job) => signal.updaters.delete(job),
      valueCompared: false,
    };
  }

  if (typeof source !== 'function') {
    throw new TypeError('watch() expects a signal or a getter function as its source.');
  }

  const getter = source as () => unknown;
  // getter 的依赖集合在每次重算时都可能变化（例如三元分支切换），
  // 因此 getter 每次取值都用 trackSignals 重新收集，再同步订阅关系。
  let trackedDeps = new Set<Signal<any>>();
  let subscribedJob: Job | null = null;

  const syncSubscriptions = (deps: Set<Signal<any>>): void => {
    if (!subscribedJob) {
      trackedDeps = deps;
      return;
    }

    for (const dep of trackedDeps) {
      if (!deps.has(dep)) {
        dep.updaters.delete(subscribedJob);
      }
    }
    for (const dep of deps) {
      if (!trackedDeps.has(dep)) {
        dep.updaters.add(subscribedJob);
      }
    }
    trackedDeps = deps;
  };

  return {
    peek: () =>
      untrack(() => {
        // 首次取值发生在订阅前，用 untrack 避免污染外层正在进行的依赖收集。
        const { value, deps } = trackSignals(getter);
        syncSubscriptions(deps);
        return value;
      }),
    subscribe: (job) => {
      subscribedJob = job;
      for (const dep of trackedDeps) {
        dep.updaters.add(job);
      }
    },
    unsubscribe: (job) => {
      for (const dep of trackedDeps) {
        dep.updaters.delete(job);
      }
      subscribedJob = null;
    },
    valueCompared: true,
  };
};

export function watch<T, Immediate extends boolean = false>(
  source: WatchSource<T>,
  callback: WatchCallback<T, Immediate>,
  options?: WatchOptions & { immediate?: Immediate },
  scheduler?: Scheduler
): WatchStopHandle;
export function watch<T extends readonly unknown[], Immediate extends boolean = false>(
  sources: { [K in keyof T]: WatchSource<T[K]> },
  callback: WatchCallback<T, Immediate>,
  options?: WatchOptions & { immediate?: Immediate },
  scheduler?: Scheduler
): WatchStopHandle;
export function watch<T>(
  source: WatchSource<T> | readonly WatchSource<unknown>[],
  callback:
    | ((current: T, previous: T | undefined) => void)
    | ((current: T[], previous: T[] | undefined) => void),
  options: WatchOptions = {},
  scheduler: Scheduler = defaultScheduler
): WatchStopHandle {
  const rawSources = Array.isArray(source) ? source : [source];
  const isMultiSource = Array.isArray(source);
  const sources = rawSources.map((entry) => normalizeWatchSource(entry as WatchSource<unknown>));
  const { immediate = false, deep = false } = options;
  const takeSnapshot = (value: unknown): unknown =>
    deep ? cloneWatchSnapshot(value) : value;

  let previousValues: unknown[] = sources.map((entry) => takeSnapshot(entry.peek()));

  const invoke = (currentValues: unknown[], snapshot: unknown[] | undefined): void => {
    if (isMultiSource) {
      (callback as (current: unknown[], previous: unknown[] | undefined) => void)(
        currentValues,
        snapshot
      );
      return;
    }

    (callback as (current: unknown, previous: unknown | undefined) => void)(
      currentValues[0],
      snapshot ? snapshot[0] : undefined
    );
  };

  const runWatch = () => {
    // watch 回调在调度队列中执行，不需要建立依赖；用 peek 取稳定快照，
    // 避免对象型 signal 的 `.value` 返回路径视图造成“永远不相等”的误判。
    const nextValues = sources.map((entry) => entry.peek());

    if (sources.some((entry) => entry.valueCompared)) {
      // getter 源按「值」语义去重：store 写入相同值时版本号仍会自增，
      // 若不去重会把无变化的通知也当作一次变更回调出去。
      // 返回新对象字面量的 getter 用 `Object.is` 永远不相等，这里退回浅层结构化比较。
      const unchanged = nextValues.every((next, index) => {
        if (!sources[index]!.valueCompared) {
          return true;
        }

        const previous = previousValues[index];
        return Object.is(next, previous) || isDeepEqual(next, previous);
      });

      if (unchanged) {
        previousValues = nextValues.map(takeSnapshot);
        return;
      }
    }

    if (deep && previousValues.every((previous, index) => isDeepEqual(nextValues[index], previous))) {
      // 内容没变时不回调，但仍然保留最新引用，避免用户原地改值后快照过期。
      previousValues = nextValues.map(takeSnapshot);
      return;
    }

    const snapshot = previousValues;
    previousValues = nextValues.map(takeSnapshot);
    invoke(nextValues, snapshot);
  };

  const scheduleWatch = () => {
    // watch 属于“effect 队列”：优先级较低，且会被合并调度
    scheduler.scheduleEffect(runWatch);
  };

  for (const entry of sources) {
    entry.subscribe(scheduleWatch);
  }

  if (immediate) {
    // 首次执行与 createEffect 对齐：同步跑一次，旧值语义是“不存在”。
    invoke(sources.map((entry) => entry.peek()), undefined);
  }

  return () => {
    for (const entry of sources) {
      entry.unsubscribe(scheduleWatch);
    }
  };
}

export const createDeferred = <T>(
  source: SignalSource<T>,
  options: DeferredOptions = {},
  scheduler: Scheduler = defaultScheduler
): ReadonlySignal<T> => {
  const timeoutMs = options.timeoutMs ?? 0;
  const deferred = createSignal(source.peek(), scheduler);
  let timerId: ReturnType<typeof setTimeout> | null = null;

  watch(
    source,
    (current) => {
      if (timerId !== null) {
        clearTimeout(timerId);
      }

      // 合并连续变更：只在 timeout 到达后写入最新值
      timerId = setTimeout(() => {
        writeSignalValue(deferred, current);
        timerId = null;
      }, timeoutMs);
    },
    undefined,
    scheduler
  );

  return readonly(deferred);
};
