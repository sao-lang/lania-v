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

export type SignalSetter<T> = (value: T | ((prev: T) => T)) => T;
export type SignalSource<T> = Signal<T> | ReadonlySignal<T>;
export type ReadonlySignal<T> = (() => T) & {
  updaters: Set<Job>;
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

export type Signal<T> = (() => T) & {
  updaters: Set<Job>;
  peek: () => T;
  set: SignalSetter<T>;
  debugId: number;
  // Sets a raw value even if it's a function/class constructor.
  setValue: (value: T) => T;
};

/** 编译产物里的 computed 字段：可调用、可 peek，但不带 setter。 */
export type ComputedAccessor<T> = (() => T) & {
  peek: () => T;
};

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

  const read = (() => {
    collectActiveSignal(read as Signal<any>);
    return currentValue;
  }) as Signal<T>;

  read.debugId = nextSignalDebugId++;
  read.peek = () => currentValue;
  read.updaters = updaters;
  read.set = (value) => {
    const nextValue =
      typeof value === 'function'
        ? (value as (prev: T) => T)(currentValue)
        : value;

    // 使用 Object.is 确保 NaN 等边界值行为一致
    if (Object.is(currentValue, nextValue)) {
      return currentValue;
    }

    const previousValue = currentValue;
    currentValue = nextValue;
    if (isDevEnvironment()) {
      emitSignalDebugEvent({
        type: 'set',
        signalId: read.debugId,
        previous: previousValue,
        current: nextValue,
      });
    }

    // set 只“通知”，具体执行时机交给 scheduler（避免深层嵌套 set 造成同步抖动）
    for (const updater of updaters) {
      scheduler.scheduleSignal(updater, getSignalPriority());
    }

    return currentValue;
  };

  read.setValue = (value: T) => {
    if (typeof value === 'function') {
      // Treat functions/classes as raw values, not updater callbacks.
      return read.set((() => value) as unknown as (prev: T) => T);
    }
    return read.set(value);
  };

  return read;
};

/**
 * 创建一个惰性可读句柄：每次调用都重新求值，不参与调度。
 *
 * 编译产物用它承载 `createMemo` 的实例字段语义：
 * 调用 `this.x()` 总能拿到最新派生值，裸引用 `this.x` 得到的对象与 signal 形态一致。
 * 因为不缓存，也不会把调度顺序问题带进组件更新链路。
 */
export const createComputedAccessor = <T>(compute: () => T): ComputedAccessor<T> => {
  const read = (() => compute()) as ComputedAccessor<T>;
  read.peek = () => compute();
  return read;
};

export const readonly = <T>(signal: SignalSource<T>): ReadonlySignal<T> => {
  const read = (() => signal()) as ReadonlySignal<T>;
  read.peek = signal.peek;
  read.updaters = signal.updaters;
  return read;
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

export function watch<T, Immediate extends boolean = false>(
  source: SignalSource<T>,
  callback: WatchCallback<T, Immediate>,
  options?: WatchOptions & { immediate?: Immediate },
  scheduler?: Scheduler
): WatchStopHandle;
export function watch<T extends readonly unknown[], Immediate extends boolean = false>(
  sources: { [K in keyof T]: SignalSource<T[K]> },
  callback: WatchCallback<T, Immediate>,
  options?: WatchOptions & { immediate?: Immediate },
  scheduler?: Scheduler
): WatchStopHandle;
export function watch<T>(
  source: SignalSource<T> | readonly SignalSource<unknown>[],
  callback:
    | ((current: T, previous: T | undefined) => void)
    | ((current: T[], previous: T[] | undefined) => void),
  options: WatchOptions = {},
  scheduler: Scheduler = defaultScheduler
): WatchStopHandle {
  const sources = Array.isArray(source) ? source : [source];
  const isMultiSource = Array.isArray(source);
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
    const nextValues = sources.map((entry) => entry());

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
    entry.updaters.add(scheduleWatch);
  }

  if (immediate) {
    // 首次执行与 createEffect 对齐：同步跑一次，旧值语义是“不存在”。
    invoke(sources.map((entry) => entry.peek()), undefined);
  }

  return () => {
    for (const entry of sources) {
      entry.updaters.delete(scheduleWatch);
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
