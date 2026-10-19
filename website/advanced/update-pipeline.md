# 更新链路

这一章沿着一次 `set()` 的路径，解释运行时的执行顺序。

## 总览

```text
Signal.set
  → Scheduler.scheduleSignal
  → microtask flush
  → Updater.run
  → compute
  → commit
  → Slot.write
  → DOM
```

## 1. 写入 Signal

```ts
read.set = (value) => {
  const next = typeof value === 'function' ? value(current) : value;

  if (Object.is(current, next)) {
    return current;
  }

  current = next;

  for (const updater of updaters) {
    scheduler.scheduleSignal(updater, getSignalPriority());
  }

  return current;
};
```

关键点：

- 等值短路；
- 不直接执行 Updater，只入队；
- 优先级由 `getSignalPriority()` 决定，默认 `normal`；
- `startTransition()` 会在同步写入阶段把它改为 `low`。

## 2. 调度器排队

`Scheduler` 内部有四类队列：

```ts
private readonly queue = new Map<SchedulerPriority, Set<Job>>();
private readonly lifecycleQueue = new Set<Job>();
private readonly effectQueue = new Set<Job>();
private readonly unitQueue = new Map<SchedulerPriority, UnitOfWork[]>();
```

| 队列 | 入口 |
| --- | --- |
| 普通队列 | `schedule()` / `scheduleSignal()` |
| lifecycle | `scheduleLifecycle()` |
| effect | `scheduleEffect()` |
| unit-of-work | `scheduleUnitOfWork()` |

`Set` 会自动去重：同一轮内同一个 Job 多次入队只执行一次。

## 3. flush 顺序

```ts
while (pendingJobs > 0) {
  // 1. 普通队列：immediate → high → normal → low → idle
  // 2. lifecycle 队列
  // 3. effect 队列
}
```

因此：

- Signal 更新先于生命周期；
- 生命周期先于 effect；
- 每一轮取快照后执行，执行期间新增的任务进入下一轮。

```text
普通队列（按优先级）
  → lifecycle
  → effect
  → 若还有新任务，重复
```

## 4. Updater 执行

`BaseUpdater.run()`：

```ts
run() {
  let nextValue;

  if (!depsDiscovered) {
    const tracked = trackSignals(() => this.compute());
    nextValue = tracked.value;
    mergeDiscoveredDeps(tracked.deps);
  } else {
    nextValue = this.compute();
  }

  if (hasCommitted && Object.is(previousValue, nextValue)) {
    dirty = false;
    return;
  }

  previousValue = nextValue;
  commit(nextValue);
}
```

要点：

- 首轮会做一次依赖发现，补齐编译器静态分析漏掉的依赖；
- 后续不再追踪，直接 `compute()`；
- 结果与上次相同则跳过 `commit()`；
- `commit()` 写入 Slot 并清脏位。

## 5. Slot 写入

以 `TextSlot` 为例：

```ts
write(value) {
  if (isNodeLike(value)) {
    // 节点 / 数组：插入节点，清空文本
    return;
  }

  const next = value == null ? '' : String(value);
  if (previous === next) {
    return;
  }

  node.data = next;
  previous = next;
}
```

两层等值检查：

1. Updater 层比较计算结果；
2. Slot 层比较写入值。

目的是尽量避免无意义的 DOM 写入。

## 6. 组件级更新

除了 Updater，组件自身也可能被 Signal 触发：

```ts
trackSignal(signal) {
  this._trackedSignals.add(signal);
  if (this._isConnectedFlag) {
    signal.updaters.add(this._requestUpdateJob);
  }
}
```

`requestUpdate()`：

```ts
requestUpdate() {
  if (this._updateRequested) return;

  this._updateRequested = true;
  this._scheduler.scheduleLifecycle(() => this.performUpdate(), 'high');
}
```

`performUpdate()` 顺序：

```text
shouldUpdate(changedProps)
  → willUpdate(changedProps)
  → _flushUpdaters()
  → updated(changedProps)
  → __fcOnUpdated(changedProps)
  → firstUpdated(changedProps)  // 仅首次
```

### `_flushUpdaters()`

```text
withContextHost(host):
  1. 执行纯函数 updater（始终）
  2. 运行时 updater：
     - dirty 为真 → 执行
     - forceStructuralPass 且包含 if slot → 执行
     - 任一 slot 在 SlotTable 中为脏 → 执行
  3. 清空 SlotTable 脏位
```

`forceStructuralPass` 的作用是补一轮条件槽，避免深层结构调整被漏掉。

## 7. attach / detach

组件连接时：

```ts
for (const signal of trackedSignals) {
  signal.updaters.add(requestUpdateJob);
}

for (const updater of runtimeUpdaters) {
  updater.attach();
}
```

断开时：

```ts
for (const signal of trackedSignals) {
  signal.updaters.delete(requestUpdateJob);
}

for (const updater of runtimeUpdaters) {
  updater.detach();
}
```

这保证组件卸载后不会继续响应 Signal。

## 8. effect 队列

`createEffect()` 与 `watch()` 使用 `scheduleEffect()`：

```ts
triggerEffect = () => scheduler.scheduleEffect(runEffect);
```

Effect 排在当前轮普通更新之后，因此：

- effect 看到的是稳定状态；
- effect 中再次 `set()` 会进入下一轮；
- 不会在同一次 flush 中无限递归（除非持续产生新任务）。

## 9. 批处理

```ts
batch(() => {
  a.set(1);
  b.set(2);
});
```

`batchDepth > 0` 时：

- 不触发微任务调度；
- 所有任务留在队列中；
- 出栈后统一 `ensureScheduled()`。

结果：同一轮 flush 中所有 Updater 都看到最终值。

## 10. tick

```ts
await tick();
```

`tick()` 的解析条件：

- 当前不在 flush；
- `pendingJobs === 0`；
- 没有待执行的 unit-of-work 不影响 tick。

如果当前已经空闲，会延后一个微任务再检查，让同一调用栈后续的 `schedule()` 有机会并入本次等待。

## 11. transition 分片

```ts
await createTransition(() => {
  heavyWork();
});
```

流程：

1. `scheduleUnitOfWork(work, 'low')`；
2. 通过 `MessageChannel` 触发 `flushUnitOfWork()`；
3. 每片最多执行 5ms；
4. `run()` 返回 `false` 表示未完成，保留在队首；
5. 队列清空后关闭 channel。

## 12. 低优先级更新

```ts
startTransition(() => {
  rows.set(nextRows);
});
```

同步执行期间：

```ts
withSignalPriority('low', run);
```

因此批内所有 `set()` 都进入 `low` 桶。`pending` 通过 `tick()` 递减计数，最后一个 transition 完成时回落。

## 13. 常见时序问题

### “我 set 了，但 DOM 没变”

检查：

1. 值是否真的变了（`Object.is`）；
2. Updater 是否订阅了正确的 Signal；
3. 表达式是否被编译成静态值；
4. Slot 是否在 `SlotTable` 中；
5. 组件是否已连接（`_isConnectedFlag`）。

### “effect 看到旧值”

Effect 在 lifecycle 之后执行。如果 effect 依赖的值在同一轮被多次写入，它看到的是本轮最终值。

### “过渡期间 UI 卡住”

检查是否在 `startTransition()` 外做了大量同步计算。`startTransition()` 只降低 Signal 调度优先级，不会自动把同步循环切片。

## 下一步

- [编译管线](/advanced/compiler-pipeline)：这些 Updater 是如何生成的。
- [开发与调试](/guide/dev-and-debug)：如何观察 `Updater.run` 与 `Slot.write`。
