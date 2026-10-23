# 响应式基础

`lania-v` 的响应式系统由 Signal、Computed、Effect 和 Scheduler 组成。它不依赖组件树，也不需要 VNode。

## `createSignal()`

Signal 是一个**带 `.value` 的只读盒子**，写入方法挂在同一个对象上：

```ts
import { createSignal } from '@lania-v/runtime';

const count = createSignal(0);

count.value; // 0
count.set(1); // 1
count.set((value) => value + 1); // 2
```

读取 `count.value` 时，如果当前存在依赖收集上下文，当前 Signal 会被记录为依赖。

对象型 signal 支持嵌套路径写入，并且**按路径精确订阅**（`@lania-v/store` 的 atom 复用同一套机制）：

```ts
const user = createSignal({ name: 'Ada', profile: { city: 'Paris' } });

createEffect(() => console.log(user.value.name)); // 只订阅 ['name']
createEffect(() => console.log(user.value.profile.city)); // 只订阅 ['profile', 'city']

user.set('profile.city', 'Lyon'); // 只有第二个 effect 重跑
```

视图按路径缓存（`user.value.profile === user.value.profile`），深处写入仍然只读。

### `set()` 与 `setValue()`

`set()` 接收值或 updater 函数：

```ts
count.set(10);
count.set((value) => value * 2);
```

如果你要存的值本身就是函数，必须使用 `setValue()`，否则它会被当成 updater：

```ts
const handler = createSignal<() => void>(() => {});

handler.setValue(() => console.log('new handler')); // 存储函数本身
handler.set(() => console.log('updater')); // 用旧值计算新值
```

### `peek()`

`peek()` 读取当前值但不收集依赖：

```ts
createEffect(() => {
  const value = count.peek(); // 不会订阅 count
});
```

### 等值判断

Signal 使用 `Object.is()` 比较新旧值。`NaN` 与 `NaN` 视为相等，因此不会触发更新。

## `createMemo()`

`createMemo()` 创建派生 Signal。依赖变化时重新计算，并把结果写入内部 Signal：

```ts
const first = createSignal('Ada');
const last = createSignal('Lovelace');

const fullName = createMemo(() => `${first.value} ${last.value}`);
fullName.value; // 'Ada Lovelace'
```

几点语义：

- 初始值用 `untrack()` 计算，不会把“创建时的外部依赖”误记为依赖；
- 每次重算都会重新收集依赖并重绑订阅；
- 返回值是只读 Signal，没有 `set`；
- 在编译组件中，`createMemo` 会被编译成实例上的 `createComputedAccessor`，模板依赖由编译器静态注入。

## `createEffect()`

```ts
const stop = createEffect(() => {
  console.log('count =', count.value);
});

count.set(1); // 异步调度后执行 effect
stop(); // 解除订阅
```

Effect 可以返回清理函数：

```ts
const stop = createEffect(() => {
  const id = setInterval(() => console.log(count.value), 1000);
  return () => clearInterval(id);
});
```

Effect 的执行时机：

- 不在 `set()` 的同步调用栈里立即执行；
- 通过 Scheduler 的 effect 队列调度；
- 默认在当前一轮 signal / lifecycle 更新之后执行。

## `watch()`

`watch()` 观察一个或多个 Signal，并在变化后调用回调：

```ts
const stop = watch(count, (current, previous) => {
  console.log(`count: ${previous} -> ${current}`);
});

const stopMany = watch(
  [first, last],
  ([nextFirst, nextLast], [prevFirst, prevLast]) => {
    console.log('name changed');
  }
);
```

`watch()` 不会立即执行首次回调。需要首屏执行时，开启 `immediate`：

```ts
watch(
  count,
  (current, previous) => {
    // 首次立即执行，此时 previous 是 undefined
    console.log(previous ?? '(initial)', current);
  },
  { immediate: true }
);
```

传入对象时，`deep: true` 会按值比较新旧快照，内容没变就不触发回调，`previous` 是上一次快照的深拷贝：

```ts
watch(
  form,
  (current, previous) => {
    console.log(previous, current);
  },
  { deep: true }
);
```

`watch(source, callback, options, scheduler)` 的第三参是选项，第四参才是调度器。

::: tip 在编译组件中使用 watch
编译器只接管 `createEffect()`。在 `.lania.tsx` 里直接调用 `watch()` 时，
请自己保留停止函数并在 `onCleanup()` 中调用，或把 watch 放进 `createScope()`。
:::

## `readonly()`

```ts
const count = createSignal(0);
const publicCount = readonly(count);

publicCount.value; // 0
publicCount.peek(); // 0
// publicCount.set(1) // 类型错误
```

## `createDeferred()`

`createDeferred()` 把高频变更合并为延迟写入：

```ts
const query = createSignal('');
const deferredQuery = createDeferred(query, { timeoutMs: 200 });

// query 连续变化时，deferredQuery 只在停止 200ms 后更新一次
```

适合搜索联想、昂贵的列表过滤等场景。

## `untrack()`

在依赖收集上下文中读取值但不建立订阅：

```ts
createEffect(() => {
  const current = count.value;
  const snapshot = untrack(() => other());
  console.log(current, snapshot);
});
```

## 调度器

所有更新都进入 `Scheduler`。默认调度器是模块级单例：

```ts
import {
  batch,
  tick,
  schedule,
  scheduleIdle,
  defaultScheduler,
} from '@lania-v/runtime';
```

### 优先级

| 优先级      | 用途               |
| ----------- | ------------------ |
| `immediate` | 需要立刻执行的任务 |
| `high`      | 生命周期更新       |
| `normal`    | 普通 Signal 更新   |
| `low`       | effect、过渡更新   |
| `idle`      | 空闲任务           |

### `batch()`

把多次写入合并为一轮 flush：

```ts
batch(() => {
  first.set('Grace');
  last.set('Hopper');
});
// effect 只执行一次，看到的是最终值
```

### `tick()`

等待当前调度器稳定：

```ts
await tick();
// 此时 signal / lifecycle / effect 队列已经清空
```

`tick()` 不等待 `setTimeout`、动画、网络请求或 transition 的 unit-of-work。

### `scheduleIdle()`

```ts
scheduleIdle(() => {
  // 浏览器空闲时执行；没有 requestIdleCallback 时退回 idle 队列
});
```

### `defaultScheduler.createTransition()`

把一段工作放进低优先级队列，避免阻塞当前交互：

```ts
await defaultScheduler.createTransition(() => {
  renderLargeList();
});
```

调度器使用 `MessageChannel` 调度，并在执行时包一层 `batch()`。需要真正的时间分片时，使用 `defaultScheduler.scheduleUnitOfWork()`。

## 低优先级更新：`startTransition()`

```ts
import { startTransition, useTransition } from '@lania-v/runtime';

startTransition(() => {
  filter.set(nextFilter);
  rows.set(nextRows);
});

// 组件内读取 pending 状态
const { pending, start } = useTransition();
pending(); // boolean
```

`startTransition()` 会把同步写入阶段产生的 Signal 更新调度到 `low` 优先级。批内更新稳定 flush 后，`pending` 自动回落。

## 作用域与清理

组件内的 Signal 由组件实例托管。组件外创建的 Effect / Memo / Resource 需要显式归属：

```ts
import { createScope, createEffect, createSignal } from '@lania-v/runtime';

const scope = createScope(() => {
  const count = createSignal(0);

  createEffect(() => {
    console.log(count.value);
  });

  return count;
});

scope.value.set(1);
scope.dispose(); // 清理 scope 内注册的所有 effect / memo / resource
```

底层 API：

```ts
import { getOwner, runWithOwner, onOwnerCleanup } from '@lania-v/runtime';

const cleanup = onOwnerCleanup(() => {
  console.log('owner disposed');
});
cleanup(); // 手动移除
```

## 编译组件里的差异

在 `.lania.tsx` 中：

- `createSignal()` 会变成实例字段；
- `createMemo()` 会变成 `createComputedAccessor`；
- `createEffect()` 会被编译成 `EffectUpdater`，随组件挂载 / 卸载自动 attach / detach；
- `onMount` / `onCleanup` / `onUpdated` 是编译期标记，不是运行时可调用函数。

因此组件代码可以保持函数式写法：

```tsx
export default defineComponent(function Clock() {
  const now = createSignal(Date.now.value);
  let timer: ReturnType<typeof setInterval> | undefined;

  onMount(() => {
    timer = setInterval(() => now.set(Date.now.value), 1000);
  });

  onCleanup(() => {
    if (timer) clearInterval(timer);
  });

  return <time>{new Date(now.value).toLocaleTimeString()}</time>;
});
```

## 下一步

- [模板与绑定](/guide/templates)：把 Signal 接进 DOM。
- [组件](/guide/components)：生命周期、props、slots 与 context。
- [更新链路](/advanced/update-pipeline)：调度器内部执行顺序。
