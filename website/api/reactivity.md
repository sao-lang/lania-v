# 响应式 API

`lania-v` 的响应式系统只有四个核心概念：

- **Signal**：可读可写的最小状态单元；
- **Memo**：由其他响应式值派生的只读值；
- **Effect**：依赖变化后执行的副作用；
- **Scheduler**：决定这些任务何时执行、以什么顺序执行。

理解这四者的关系，比记住函数签名更重要：

```text
Signal.set
  → 通知订阅它的 job
  → Scheduler 排队
  → Memo / Effect / Updater 执行
```

## Signal

### `createSignal()`

```ts
createSignal<T>(initialValue: T, scheduler?: Scheduler): Signal<T>
```

创建一个 Signal。第二个参数允许你把该 Signal 的更新交给自定义调度器；绝大多数场景使用默认值即可。

```ts
import { createSignal } from '@lania-v/runtime';

const count = createSignal(0);
```

#### 为什么用 `.value` 读取

Signal 返回的是一个只读盒子对象，读取路径是 `.value`：

```ts
count.value; // 0
```

这样做有两个直接好处：

1. 读取动作可以被依赖收集系统感知（getter 每次访问都会收集依赖）；
2. Signal 与其他状态 API 形态统一：`createStore` 用 `state.xxx`，signal 用 `sig.value`，写入都是 `set`。

```ts
function useDouble(source: ReadonlySignal<number>) {
  return createMemo(() => source.value * 2);
}

const double = useDouble(count);
```

只要访问 `.value`，依赖关系就成立。

#### 读取语义

| 写法 | 是否收集依赖 | 说明 |
| --- | --- | --- |
| `count()` | 是 | 在 Effect / Memo / Updater 中被记录 |
| `count.peek()` | 否 | 只读当前值，适合“看一眼但不订阅” |
| `count.updaters` | 否 | 直接访问订阅集合，通常只给运行时内部使用 |
| `count.debugId` | 否 | 开发调试 ID |

`peek()` 的典型场景是读取初始值：

```ts
const initial = count.peek();
```

#### 写入语义

```ts
count.set(1);
count.set((previous) => previous + 1);
```

`set()` 接受值或 updater。它遵循以下规则：

1. 如果参数是函数，会以当前值调用它；
2. 用 `Object.is()` 比较新旧值；
3. 值相等时直接返回当前值，不通知任何订阅者；
4. 值不等时先更新内部值，再把所有订阅 job 交给调度器。

```ts
count.set(Number.NaN);
count.set(Number.NaN); // 相等，不会触发更新
```

#### `setValue()`：存储函数本身

因为 `set()` 会把函数当作 updater，所以存储函数值需要显式使用 `setValue()`：

```ts
const formatter = createSignal<(value: number) => string>((value) => String(value));

formatter.setValue((value) => `${value}%`); // 存函数
formatter()(42); // '42%'
```

#### 调度器参数

```ts
const custom = createSignal(0, myScheduler);
```

`Signal.set()` 本身不执行订阅者，而是调用：

```ts
scheduler.scheduleSignal(updater, getSignalPriority());
```

因此：

- 同一个 Signal 的多个订阅者会被合并调度；
- 优先级由当前 `getSignalPriority()` 决定；
- `startTransition()` 期间写入会落到 `low` 优先级。

### `Signal<T>`

```ts
type Signal<T> = (() => T) & {
  updaters: Set<Job>;
  peek: () => T;
  set: SignalSetter<T>;
  debugId: number;
  setValue: (value: T) => T;
};

type SignalSetter<T> = (value: T | ((prev: T) => T)) => T;
```

| 成员 | 说明 |
| --- | --- |
| `()` | 读取并收集依赖 |
| `set(value)` | 写入值或 updater，返回新值 |
| `setValue(value)` | 原样存储函数 / 类 |
| `peek()` | 读取但不收集依赖 |
| `updaters` | 当前订阅者集合（`Job`） |
| `debugId` | 自增调试 ID |

### `ReadonlySignal<T>`

```ts
type ReadonlySignal<T> = (() => T) & {
  updaters: Set<Job>;
  peek: () => T;
};
```

`createMemo()`、`createResource()`、`readonly()` 都返回这种形态。

### `readonly()`

```ts
readonly<T>(signal: SignalSource<T>): ReadonlySignal<T>
```

创建一个只读视图。它**不复制**内部值，也不复制订阅集合：

```ts
const count = createSignal(0);
const publicCount = readonly(count);

publicCount();      // 0
publicCount.peek(); // 0
// publicCount.set(1); // 类型错误
```

视图和原 Signal 共享同一份 `updaters`，因此：

- 通过原 Signal 写入，视图会收到通知；
- 无法通过视图写入；
- 运行时仍然可以通过 `updaters` 看到订阅关系。

适合把内部状态暴露给外部读取，但保留写入控制权。

## Memo

### `createMemo()`

```ts
createMemo<T>(compute: () => T, scheduler?: Scheduler): ReadonlySignal<T>
```

创建一个派生 Signal：

```ts
const first = createSignal('Ada');
const last = createSignal('Lovelace');

const fullName = createMemo(() => `${first()} ${last()}`);
fullName(); // 'Ada Lovelace'
```

#### 创建时就会计算一次

与某些“惰性 memo”不同，`createMemo()` 在创建时会立即计算初始值，并且这次计算是 `untrack()` 的：

```ts
createMemo(() => {
  // 首次计算不会把外层的依赖误加进来
  return expensiveWork();
});
```

此后依赖变化时，会：

1. 解绑旧的依赖；
2. 重新执行 `compute()`；
3. 收集新的依赖；
4. 把结果写入内部 Signal。

#### 什么时候用 Memo

适合：

- 昂贵的过滤 / 排序 / 格式化；
- 一个派生值被多个位置读取；
- 需要把“依赖关系”显式固定下来。

不适合：

- 纯副作用（用 `createEffect()`）；
- 只读一次的普通值（直接读 Signal）；
- 结果依赖非响应式外部变量，但你又期望自动更新。

#### 编译组件中的差异

在 `.lania.tsx` 中，编译器会把 `createMemo()` 声明编译成实例上的 `createComputedAccessor`：

```ts
// 源码
const double = createMemo(() => count() * 2);

// 编译后（概念上）
double = createComputedAccessor(() => this.count() * 2);
```

差异：

| `createMemo` | `createComputedAccessor` |
| --- | --- |
| 缓存结果 | 每次调用重新计算 |
| 有内部 Signal | 没有内部 Signal |
| 依赖变化时重算 | 不参与调度 |
| 返回 `ReadonlySignal` | 返回 `ComputedAccessor`（`.value` 读取） |

模板中的依赖由编译器静态注入，因此不需要句柄自己缓存。

### `createComputedAccessor()`

```ts
createComputedAccessor<T>(compute: () => T): ComputedAccessor<T>

type ComputedAccessor<T> = (() => T) & { peek: () => T };
```

用法：

```ts
const accessor = createComputedAccessor(() => count() * 2);
accessor();      // 重新计算
accessor.peek(); // 重新计算
```

它适合“每次都希望拿到最新值、但不需要缓存”的场景。业务代码通常不需要直接使用它。

## Effect

### `createEffect()`

```ts
createEffect(effect: EffectCallback, scheduler?: Scheduler): WatchStopHandle

type EffectCallback = () => void | (() => void);
type WatchStopHandle = () => void;
```

```ts
const stop = createEffect(() => {
  console.log('count =', count());
});
```

执行语义：

1. 创建时立即执行一次；
2. 依赖变化时，通过 `scheduler.scheduleEffect()` 排队；
3. 下一次执行前调用上一次返回的清理函数；
4. 调用 `stop()` 时执行清理并解绑依赖。

```ts
const stop = createEffect(() => {
  const id = setInterval(() => console.log(count()), 1000);
  return () => clearInterval(id);
});

stop();
```

#### 执行时机

Effect 不在 `set()` 的同步调用栈里执行。调度器会把它放到当前轮 signal / lifecycle 更新之后：

```text
Signal 更新
  → 生命周期
  → Effect
```

因此 Effect 通常看到的是“本轮稳定后的状态”。

#### 自动清理

`createEffect()` 会调用 `onOwnerCleanup(stop)`。如果当前存在 Owner（例如 `createScope()`），Effect 会随作用域销毁自动停止。

```ts
const scope = createScope(() => {
  createEffect(() => console.log(count()));
});

scope.dispose(); // effect 自动停止
```

#### 编译组件中的差异

在 `.lania.tsx` 中，编译器会把直接出现的 `createEffect(...)` 识别为组件 effect，并生成 `EffectUpdater`：

- 组件连接时 attach；
- 组件断开时 detach；
- 不需要手写 `stop()`。

### `watch()`

```ts
interface WatchOptions {
  immediate?: boolean;
  deep?: boolean;
}

watch<T, Immediate extends boolean = false>(
  source: SignalSource<T>,
  callback: (
    current: T,
    previous: Immediate extends true ? T | undefined : T
  ) => void,
  options?: WatchOptions & { immediate?: Immediate },
  scheduler?: Scheduler
): WatchStopHandle

watch<T extends readonly unknown[], Immediate extends boolean = false>(
  sources: { [K in keyof T]: SignalSource<T[K]> },
  callback: (
    current: T,
    previous: Immediate extends true ? T | undefined : T
  ) => void,
  options?: WatchOptions & { immediate?: Immediate },
  scheduler?: Scheduler
): WatchStopHandle
```

```ts
const stop = watch(count, (current, previous) => {
  console.log(`${previous} -> ${current}`);
});
```

第三参是选项，第四参才是调度器：

```ts
watch(count, (current, previous) => {
  console.log(current, previous);
}, { immediate: true });

watch(form, (current, previous) => {
  console.log(current, previous);
}, { deep: true });
```

选项行为：

| 选项 | 行为 |
| --- | --- |
| `immediate` | 创建时同步执行一次回调，首次 `previous` 为 `undefined` |
| `deep` | 按值比较新旧快照，内容没变时不回调；`previous` 是上一次快照的深拷贝 |

`deep` 的比较范围限于普通对象与数组，DOM 节点、类实例按引用比较。

与 `createEffect()` 的区别：

| `createEffect` | `watch` |
| --- | --- |
| 创建时立即执行 | 默认不立即执行（`immediate: true` 时立即执行） |
| 回调无参数 | 回调收到新旧值 |
| 适合副作用 | 适合观察变化 |
| 可返回清理函数 | 不处理清理函数 |

多个来源：

```ts
watch([first, last], ([nextFirst, nextLast], [prevFirst, prevLast]) => {
  console.log('name changed');
});
```

::: warning 在编译组件中使用 watch
编译器只接管直接出现的 `createEffect()`。`watch()` 返回的停止函数需要自己保存，并在 `onCleanup()` 中调用，或把 `watch()` 放进 `createScope()`。
:::

### `untrack()`

```ts
untrack<T>(run: () => T): T
```

在不收集依赖的上下文中执行：

```ts
createEffect(() => {
  const current = count();
  const snapshot = untrack(() => other());
  console.log(current, snapshot);
});
```

- `current` 会订阅；
- `snapshot` 不会订阅。

### `createDeferred()`

```ts
createDeferred<T>(
  source: SignalSource<T>,
  options?: { timeoutMs?: number },
  scheduler?: Scheduler
): ReadonlySignal<T>
```

把连续变更合并为延迟写入：

```ts
const query = createSignal('');
const deferredQuery = createDeferred(query, { timeoutMs: 200 });
```

行为：

1. 监听 `source`；
2. 每次变化都清除上一个定时器；
3. 在 `timeoutMs` 后写入最新值；
4. 返回只读 Signal。

适合搜索框、昂贵过滤等“只需要最终值”的场景。

## Scheduler

### 设计目标

`Scheduler` 负责：

- 把更新合并到微任务；
- 按优先级分桶；
- 区分普通更新、生命周期、effect；
- 提供 transition 分片；
- 提供 `tick()` 等待稳定。

```ts
import { defaultScheduler, Scheduler } from '@lania-v/runtime';
```

`defaultScheduler` 是模块级单例。Signal、Effect、`tick()`、`batch()` 默认都用它。

### 优先级

```ts
type SchedulerPriority = 'immediate' | 'high' | 'normal' | 'low' | 'idle';
```

| 优先级 | 典型用途 |
| --- | --- |
| `immediate` | 需要尽快执行的任务 |
| `high` | 组件生命周期更新 |
| `normal` | 普通 Signal 更新 |
| `low` | effect、transition |
| `idle` | 空闲任务 |

执行顺序：

```text
immediate → high → normal → low → idle
  → lifecycle
  → effect
```

### 方法

```ts
class Scheduler {
  schedule(job: Job, priority?: SchedulerPriority): void;
  scheduleSignal(job: Job, priority?: SchedulerPriority): void;
  scheduleLifecycle(job: Job, priority?: SchedulerPriority): void;
  scheduleEffect(job: Job, priority?: SchedulerPriority): void;
  scheduleUnitOfWork(work: UnitOfWork, priority?: SchedulerPriority): void;
  scheduleIdle(work: () => void): void;

  flush(): void;
  batch<T>(fn: () => T): T;
  createTransition<T>(work: () => T): Promise<T>;
  createDoubleBufferState<T>(initialValue: T): DoubleBufferState<T>;
  tick(): Promise<void>;

  get size(): number;
}
```

### 模块级快捷函数

```ts
import {
  schedule,
  scheduleSignal,
  scheduleLifecycle,
  scheduleEffect,
  scheduleIdle,
  batch,
  tick,
  createDoubleBufferState,
} from '@lania-v/runtime';
```

它们都转发到 `defaultScheduler`。

### `batch()`

```ts
const a = createSignal(0);
const b = createSignal(0);
const total = createMemo(() => a() + b());

batch(() => {
  a.set(1);
  b.set(2);
});

total(); // 3，只计算一次
```

`batch()` 通过 `batchDepth` 阻止调度。出栈后统一安排一轮 flush。

### `tick()`

```ts
await tick();
```

等待当前调度器稳定：

- 不在 flush；
- 没有待执行任务。

如果调用时已经空闲，会延迟一个微任务再检查，使同一调用栈后续的 `schedule()` 能并入本次等待。

::: tip tick 的边界
`tick()` 不等待 `setTimeout`、动画、网络请求或 transition 的 unit-of-work。
:::

### `defaultScheduler.createTransition()`

```ts
await defaultScheduler.createTransition(() => {
  renderLargeList();
});
```

把一段同步工作放进低优先级队列：

- 使用 `MessageChannel` 调度；
- 执行时包在 `batch()` 中，期间的 Signal 写入合并成一次 flush；
- 适合把重活延后，避免阻塞当前交互。

需要真正的时间分片时，使用 `defaultScheduler.scheduleUnitOfWork()`，并让 `run()` 在未完成时返回 `false`。

### `createDoubleBufferState()`

```ts
const buffer = createDoubleBufferState({ x: 0 });

buffer.update((current) => ({ ...current, x: 1 }));
buffer.pending; // { x: 1 }
buffer.current; // { x: 0 }
buffer.commit();
buffer.current; // { x: 1 }
```

用于“先暂存多次更新，再一次性提交”的场景。

### `withSignalPriority()`

```ts
withSignalPriority('low', () => {
  rows.set(nextRows);
});
```

在同步执行期间临时覆盖 Signal 的默认优先级。`startTransition()` 内部就是它。

### `scheduleIdle()`

```ts
scheduleIdle(() => {
  // 浏览器空闲时执行
});
```

优先使用 `requestIdleCallback`，不支持时退回 `idle` 队列。

## Transition 状态

### `startTransition()`

```ts
startTransition<T>(run: () => T): T
```

```ts
startTransition(() => {
  query.set(nextQuery);
  rows.set(nextRows);
});
```

- 同步执行 `run()`；
- 批内 Signal 写入使用 `low` 优先级；
- 通过 `useTransition().pending` 暴露 pending 状态；
- 不影响依赖模型，也不引入新的渲染阶段。

### `useTransition()`

```ts
const { pending, start } = useTransition();

start(() => {
  filter.set(nextFilter);
});

pending(); // boolean
```

`pending` 是全局标志：多个 transition 同时存在时使用计数管理，最后一个结束后回落。

## Store

### 为什么需要 Store

多个 Signal 适合平铺状态，但嵌套对象会出现两个问题：

1. 修改深层字段需要手动展开；
2. 读取任意字段都可能订阅整个对象。

`createStore()` 用“路径 + 版本 Signal”解决：

- 读取 `state.user.name` 订阅 `['user', 'name']`；
- 写入必须走 `set()`，只通知受影响的祖先 / 后代路径；
- 路径视图按需创建并缓存，视图是只读的，属性赋值会直接报错。

### `createStore()`

```ts
createStore<T extends object>(
  initialValue: T,
  scheduler?: Scheduler
): Store<T>
```

`Store<T>` 在 `T` 的对象式访问之上提供 `set` / `peek`，与 `createSignal()` 的句柄形态一致。

```ts
const state = createStore({
  user: { name: 'Ada', age: 36 },
  list: [] as number[],
});
```

#### 读取

```ts
state.user.name;
state.list[0];
state.list.length;
```

- 读取原始值会订阅该路径；
- 读取嵌套对象会返回按路径缓存的只读视图，不会订阅父路径；
- 方法调用会自动绑定到所属对象；
- 属性是只读的，任何 `state.xxx = ...` 都会抛 `TypeError`。

#### 写入

```ts
// 整体替换（未给出的字段会被丢弃）
state.set({ user: { name: 'Grace' }, list: [] });

// 点路径写入
state.set('user.name', 'Grace');

// 数组路径
state.set(['user', 'name'], 'Grace');

// 分段路径写入
state.set('user', 'name', 'Grace');

// 路径 + updater
state.set('list', (list: number[]) => [...list, 1]);

// 数组下标
state.set('list', 0, 99);
state.set('list.0.title', 'updated');
```

`set` 不合并：单参数一律整体替换，局部更新请用嵌套路径。路径不存在时会按需创建中间对象。

两个参数且首参为字符串时按 `.` 拆分路径；首参为数组时按分段路径处理；三个及以上参数同样按分段路径处理。

路径更新采用不可变策略：

1. 复制根容器；
2. 复制路径上的每一层；
3. 替换目标字段。

```ts
const before = state.user;
state.set('user.name', 'Grace');
state.user !== before; // true
```

#### 方法绑定

```ts
const state = createStore({
  count: 1,
  increment() {
    this.set('count', (count: number) => count + 1);
  },
});

state.increment();
```

方法会绑定回当前路径，因此 `this` 指向正确对象；但 `this` 同样是只读视图，写入需要走 `set()`。

#### `peek()`

```ts
const raw = state.peek();
```

返回当前原始对象且不建立订阅。

#### `__raw`

```ts
const raw = state.user.__raw;
```

读取当前路径的原始值。它是内部逃生口，业务代码应优先保持响应式读取。

### `produce()`

```ts
produce<T extends object>(
  store: Store<T>,
  recipe: (draft: T) => T
): T
```

用纯函数计算下一个状态：

```ts
produce(state, (draft) => ({
  ...draft,
  list: [...draft.list, 1],
  user: { ...draft.user, name: 'Grace' },
}));
```

约束：

- `draft` 是只读视图，回调内不能直接赋值或调用数组变更方法；
- 回调必须有返回值，返回值作为新状态整体写回；
- 需要局部更新时优先用 `state.set('path.to.value', next)`。

### `getStorePathSignal()`

```ts
getStorePathSignal(
  store: unknown,
  path: readonly StorePathSegment[]
): Signal<number>
```

把某条路径的版本 Signal 拿出来：

```ts
const nameSignal = getStorePathSignal(state, ['user', 'name']);

createEffect(() => {
  console.log(nameSignal());
});
```

适合 composable、手动订阅和编译器无法静态分析的场景。

## Resource

### `createResource()`

```ts
createResource<T>(
  key: Signal<any> | readonly Signal<any>[],
  fetcher: () => Promise<T>,
  options?: {
    initialValue?: T;
    scheduler?: Scheduler;
  }
): [ReadonlySignal<T | undefined>, ResourceControls<T>]

interface ResourceControls<T> {
  loading: ReadonlySignal<boolean>;
  error: ReadonlySignal<unknown>;
  refetch(): Promise<T | undefined>;
}
```

```ts
const userId = createSignal('1');

const [user, { loading, error, refetch }] = createResource(userId, async () => {
  const response = await fetch(`/api/users/${userId()}`);
  return response.json();
});
```

行为：

1. 创建时立即执行一次 `fetcher()`；
2. 任一 key Signal 变化后重新执行；
3. 每次请求递增 `requestId`；
4. 只有最新请求可以提交结果；
5. `loading` 在请求开始时置为 `true`，结束时置为 `false`；
6. `error` 记录最新请求的错误；
7. `refetch()` 手动重新执行。

#### 为什么需要显式 key

资源层不做自动依赖收集。key 必须显式传入：

```ts
// 正确
createResource(userId, fetchUser);

// 错误：普通函数不是 Signal，不会触发重新拉取
createResource(() => userId(), fetchUser);
```

在编译组件中，如果 key 来自 prop，先用 `createMemo` 转换成 Signal：

```tsx
const id = createMemo(() => props.id);
const [user] = createResource(id, fetchUser);
```

#### 竞态处理

```ts
// 请求 A 慢，请求 B 快
// A 返回时 requestId 已过期，不会覆盖 B 的结果
```

这是资源层最重要的保证之一。

## Selector

### `createSelector()`

```ts
createSelector<T, K = T>(
  source: SignalSource<T>,
  equals?: (key: K, value: T) => boolean
): Selector<T, K>

interface Selector<T, K = T> {
  (key: K): boolean;
  dispose(): void;
}
```

问题场景：

```tsx
<Each items={items()}>
  {(item) => <Row selected={selectedId() === item.id} />}
</Each>
```

每个 `Row` 都订阅 `selectedId`，一次选中变化会触发整列表。

`createSelector()` 为每个 key 建立独立布尔 Signal：

```ts
const isSelected = createSelector(selectedId);
```

只有“该 key 的选中态真的变化”时才更新对应 Signal。

自定义比较：

```ts
const isCurrent = createSelector(currentUser, (key, value) => key.id === value?.id);
```

释放：

```ts
isSelected.dispose();
```

`createSelector` 内部使用一个运行时 `createEffect`，不会被编译器自动改写。在组件中使用时请手动 `dispose()` 或放进 `createScope()`。

## Owner / Scope

### 为什么需要 Owner

组件内的 Effect / Memo / Resource 由组件托管。组件外创建的资源需要一个显式归属，否则无法统一释放。

```ts
interface Owner {
  parent: Owner | null;
  disposers: Set<() => void>;
  disposed: boolean;
}

interface Scope<T> {
  value: T;
  dispose: () => void;
}
```

### `createScope()`

```ts
const scope = createScope(() => {
  const count = createSignal(0);

  createEffect(() => {
    console.log(count());
  });

  return count;
});

scope.value.set(1);
scope.dispose();
```

作用域内这些 API 会自动注册清理：

- `createEffect()`
- `createMemo()`
- `createResource()`

不自动注册的：

- `createSelector()`（需要手动 `dispose()`）
- `watch()`（需要手动调用停止函数）

### `getOwner()` / `runWithOwner()`

```ts
const owner = getOwner();

runWithOwner(owner, () => {
  createEffect(() => {
    /* 归属到指定 owner */
  });
});
```

### `onOwnerCleanup()`

```ts
onOwnerCleanup(cleanup: () => void): () => void
```

把清理函数挂到当前 Owner：

- 没有 Owner 时原样返回；
- Owner 已销毁时立即执行；
- 返回一个函数用于手动移除。

## Context

实践用法、Provider 查找规则与常见问题见 [上下文（Context）](/guide/context)。

### 设计模型

Context 通过 DOM 事件冒泡实现，不依赖组件树全局变量：

```text
consumer dispatch 'lania:context-request'
  → 最近的 provider 拦截
  → resolve 对应 ReadonlySignal
```

优点：

- Custom Element 与函数组件共用；
- 跨 Shadow DOM 使用 `composed: true`；
- 没有 Provider 时自动退回默认值。

### `createContext()`

```ts
createContext<T>(defaultValue: T, description?: string): Context<T>

interface Context<T> {
  readonly id: symbol;
  readonly defaultValue: ReadonlySignal<T>;
  readonly description?: string;
}
```

```ts
const ThemeContext = createContext<'light' | 'dark'>('light');
```

### `provideContext()`

```ts
// 运行时：显式指定宿主
provideContext<T>(
  host: EventTarget,
  context: Context<T>,
  value: T | ReadonlySignal<T> | (() => T)
): () => void

// 编译组件内：编译器补 this
provideContext<T>(
  context: Context<T>,
  value: T | ReadonlySignal<T> | (() => T)
): () => void
```

```ts
// 运行时 / 自定义元素
const dispose = provideContext(element, ThemeContext, themeSignal);
dispose();

// 编译组件内（会被改写成 provideContext(this, ThemeContext, theme)）
provideContext(ThemeContext, theme);
```

行为：

- 在 `host` 上监听 `lania:context-request`；
- 匹配 `context.id` 时 `stopPropagation()`；
- 把值解析为只读 Signal；
- 返回取消提供的函数。

值类型：

| 传入 | 行为 |
| --- | --- |
| Signal / Memo | 直接使用 |
| `() => T` | 初始化时求值一次，包装为 Signal |
| 普通值 | 包装为 Signal |

### `useContext()`

```ts
useContext<T>(
  context: Context<T>,
  host?: { dispatchEvent(event: Event): boolean }
): ReadonlySignal<T>
```

在组件作用域内自动使用当前宿主：

```tsx
const theme = useContext(ThemeContext);
return <p>{theme()}</p>;
```

在组件外或需要显式指定宿主时传第二个参数：

```ts
const theme = useContext(ThemeContext, element);
theme(); // 当前值
```

没有 provider 时返回 `context.defaultValue`。

## 工具

### `createUniqueId()`

```ts
createUniqueId(prefix?: string): string
```

```ts
const id = createUniqueId('field'); // 'field-1'
```

- 单调递增；
- 服务端 / 客户端按相同顺序渲染时能得到一致序列；
- 适合 `label for`、`aria-labelledby`；
- 不保证并发请求之间隔离。

### 高级追踪 API

```ts
import {
  isTracking,
  trackSignals,
  linkTrackedSignals,
} from '@lania-v/runtime/advanced';

const { value, deps } = trackSignals(() => count() + other());
```

| API | 说明 |
| --- | --- |
| `isTracking()` | 当前是否在收集依赖 |
| `trackSignals(run)` | 执行并返回 `{ value, deps }` |
| `linkTrackedSignals(deps)` | 把一组 Signal 加入当前收集上下文 |

这些 API 主要供高级集成和运行时内部使用。

## 常见问题

### 为什么 `count.set(1)` 后立刻读 `count()` 是新值？

Signal 内部值同步更新，调度只影响订阅者。

### 为什么 Effect 里读不到 DOM 更新后的结果？

Effect 在 lifecycle 之后执行；需要等待 DOM 写入完成时使用 `await tick()`。

### 为什么 Memo 没有重新计算？

检查它是否真的读取了目标 Signal，或表达式是否被编译成静态值。

### 为什么 Store 的深层修改没有触发更新？

`produce` 在无法 `structuredClone` 时会退回浅拷贝。改用路径写入。
