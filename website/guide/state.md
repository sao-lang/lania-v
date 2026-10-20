# 状态管理

`lania-v` 把状态分成两层：

- **响应式原语**（`@lania-v/runtime`）：`createSignal()` / `createMemo()` / `watch()`，是框架内部与组件局部状态的基础；
- **状态管理包**（`@lania/store`）：在 Signal 之上做**原子化（atom）**建模，提供派生、动作、原子族与作用域快照。

局部状态用 `createSignal()` 就够；需要跨组件共享、按字段精确订阅、需要派生与批量写入时，用 `@lania/store`。

## Signal 还是 Atom

| 场景                         | 选择                                   |
| ---------------------------- | -------------------------------------- |
| 只在单个组件内使用           | `createSignal()`                       |
| 跨组件共享的单一值           | `createAtom()`                         |
| 互相派生的状态               | `createAtom()` + `createDerivedAtom()` |
| 一组字段的整体状态（如表单） | `createAtom({...})` + 路径写入         |
| 批量修改多个 atom            | `createAction()`                       |
| 按 key 派生同构 atom         | `createAtomFamily()`                   |
| SSR / 测试需要隔离           | `createStore()` + `runWithStore()`     |

## 安装与引入

```bash
npm install @lania/store
```

```ts
import {
  createAtom,
  createDerivedAtom,
  createAction,
  createAtomFamily,
  createStore,
  runWithStore,
  bindStore,
} from '@lania/store';
```

`@lania/store` 的 atom 在运行时就是 Signal，因此编译器会像识别 `createSignal()` 一样把 `createAtom()` 声明提升为组件实例字段，模板里的 `count.value` 直接进入 `updater.deps`，不需要额外订阅代码。

## `createAtom()`

```ts
const count = createAtom(0);
const user = createAtom(
  { name: 'Ada', profile: { city: 'Paris' } },
  { key: 'user' }
);
```

| API                            | 作用                                         |
| ------------------------------ | -------------------------------------------- |
| `atom.value`                   | 响应式读取；对象类型返回按路径订阅的只读视图 |
| `atom.set(...)`                | 写入，**返回 atom 自身**，支持链式调用       |
| `atom.peek()`                  | 不建立订阅的快照读取                         |
| `atom.reset()`                 | 恢复到创建时的初始值                         |
| `atom.atomId` / `atom.atomKey` | 稳定身份与快照 key                           |

### 链式写入

`set` 返回 atom 本身，因此可以连续写多个字段：

```ts
const form = createAtom({ account: '', password: '', remember: false });

form.set('account', 'ada').set('password', 'secret').set('remember', true);
```

### 路径写入

```ts
const state = createAtom({ user: { name: 'Ada', age: 20 }, list: [1, 2] });

state.set('user.name', 'Grace'); // 点路径
state.set(['user', 'age'], 21); // 数组路径
state.set('user', 'age', 22); // 分段路径
state.set('list.0', 99); // 数组下标
state.set('user.age', (age) => age + 1); // updater
```

路径写入采用**沿路径浅拷贝**的不可变更新：只重建变更链路上的容器。

```ts
const before = state.peek();
state.set('user.name', 'Grace');
before.user.name; // 'Ada'（旧快照不受影响）
```

### 深度响应

对象 atom 的读取按路径精确订阅：

```ts
const state = createAtom({ user: { name: 'Ada', age: 20 } });

// 只订阅 ['user', 'name']，改 age 不会触发这里
createEffect(() => {
  console.log(state.value.user.name);
});

state.set('user.age', 21); // 不触发
state.set('user.name', 'Bob'); // 触发
```

### `watch` 监听

atom 是 Signal 形态，可以直接交给 `watch`：

```ts
import { watch } from '@lania-v/runtime';

watch(count, (next, previous) => {
  console.log(previous, '->', next);
});

// 只监听某个路径
watch(
  () => state.value.user.name,
  (name) => {
    console.log('name:', name);
  }
);
```

对象 atom 传 `{ deep: true }` 时按内容比较，只有真正变化才回调：

```ts
watch(state, callback, { deep: true });
```

::: tip
路径子集监听优先用 getter 形式（`() => state.value.user.name`），比 `deep: true` 更省。
:::

## `createDerivedAtom()`

派生 atom 的读函数自动收集依赖；依赖不变时不会重算。

```ts
const price = createAtom(100);
const count = createAtom(2);

const total = createDerivedAtom(() => price.value * count.value);

total.value; // 200
count.set(3);
total.value; // 300
```

### 可写派生

第二个参数是写函数，语义与 jotai 的 read/write atom 一致：

```ts
const doubled = createDerivedAtom(
  () => count.value * 2,
  (next: number) => {
    count.set(next / 2);
  }
);

doubled.set(10); // count 变成 5
doubled.value; // 10（写函数执行后同步刷新）
```

派生 atom 不进入快照（由源 atom 重新计算），但可以用 `{ key }` 标注便于调试。

## `createAction()`

动作把一组写入合并成一次提交，避免同一帧内多次重渲染。

```ts
const addTodo = createAction((text: string) => {
  todos.set((prev) => [
    ...prev,
    { id: crypto.randomUUID(), text, done: false },
  ]);
  draft.set('');
});

addTodo('write docs');
```

内部走 `batch()`：所有 `atom.set` 只触发一轮调度。

## `createAtomFamily()`

按 key 缓存 atom，保证同一个 key 拿到同一个身份：

```ts
const todoOf = createAtomFamily((id: string) =>
  createDerivedAtom(() => todos.value.find((todo) => todo.id === id) ?? null)
);

todoOf('a') === todoOf('a'); // true
```

## 作用域：`createStore()` / `runWithStore()`

默认情况下所有 atom 落在**模块级默认 store**，因此在组件内外写法完全一致。需要隔离（SSR 每请求、测试、多实例）时显式创建：

```ts
import { createStore, runWithStore } from '@lania/store';

const isolated = createStore();

const count = runWithStore(isolated, () => createAtom(0, { key: 'count' }));
count.set(7);

isolated.snapshot(); // { count: 7 }
isolated.hydrate({ count: 1 });
count.value; // 1
```

### 异步边界

`runWithStore` 只覆盖同步调用链。跨异步时需要 `bindStore()`：

```ts
const save = bindStore((text: string) => addTodo(text));
setTimeout(() => save('later'), 100); // 仍写回原 store
```

### 快照与恢复

```ts
const snapshot = store.snapshot(); // 只包含可写 atom
store.hydrate(snapshot); // 派生 atom 自动重算
```

给 atom 指定稳定的 `key` 才能被快照与持久化识别：

```ts
const settings = createAtom({ theme: 'dark' }, { key: 'settings' });
```

## 中间件

### `persist()`

```ts
import { createAtom, persist } from '@lania/store';

const settings = persist(createAtom({ theme: 'dark' }), {
  key: 'app.settings',
  pick: (value) => value.theme,
});
```

- 创建时同步读取一次；
- 每次写入回写 storage；
- storage 不可用（SSR、隐私模式）时自动降级为纯内存 atom。

### `withHistory()`

```ts
const history = withHistory(editor);

history.undo();
history.redo();
history.canUndo;
```

### `withDevtools()`

```ts
const devtools = withDevtools({ name: 'todo' });
devtools.snapshot('after-add');
```

生产环境自动降级为空实现。

## 组合示例

```tsx
import { createAction, createAtom, createDerivedAtom } from '@lania/store';
import { defineComponent } from '@lania-v/runtime';
import { Each, When } from '@lania-v/advanced';

type Todo = { id: string; text: string; done: boolean };

const todos = createAtom<Todo[]>([], { key: 'todos' });
const draft = createAtom('');

const remaining = createDerivedAtom(
  () => todos.value.filter((todo) => !todo.done).length
);
const visible = createDerivedAtom(() => todos.value);

const addTodo = createAction(() => {
  const text = draft.value.trim();
  if (!text) return;
  todos.set((prev) => [
    ...prev,
    { id: crypto.randomUUID(), text, done: false },
  ]);
  draft.set('');
});

const toggle = createAction((id: string) => {
  todos.set((prev) =>
    prev.map((todo) => (todo.id === id ? { ...todo, done: !todo.done } : todo))
  );
});

export default defineComponent(function TodoApp() {
  return (
    <section>
      <input
        model={{
          source: {
            get: () => draft.value,
            set: (value) => draft.set(String(value ?? '')),
          },
        }}
        onKeyDown={{ handler: addTodo, modifiers: { enter: true } }}
      />
      <p>剩余 {remaining.value} 项</p>
      <Each items={visible.value} key={(todo) => todo.id}>
        {(todo) => (
          <label>
            <input
              type="checkbox"
              model={{
                prop: 'checked',
                source: { get: () => todo.done, set: () => toggle(todo.id) },
              }}
            />
            <span>{todo.text}</span>
          </label>
        )}
      </Each>
      <When when={visible.value.length === 0}>
        <p>暂无待办</p>
      </When>
    </section>
  );
});
```

## 从 `createStore` 迁移

`createStore` 已从 runtime 移除，能力由 `@lania/store` 承接：

| 旧 API                      | 新写法                                        |
| --------------------------- | --------------------------------------------- |
| `createStore({...})`        | `createAtom({...})`                           |
| `store.user.name`           | `atom.value.user.name`                        |
| `store.set('user.name', v)` | `atom.set('user.name', v)`                    |
| `store.patch({...})`        | `atom.set((prev) => ({ ...prev, ...patch }))` |
| `store.reset()`             | `atom.reset()`                                |
| `store.derive(fn)`          | `createDerivedAtom(fn)`                       |
| `store.subscribe(fn)`       | `watch(atom, fn)`                             |
| `produce(store, fn)`        | `createAction()` + `atom.set(prev => next)`   |

## 下一步

- [响应式 API](/api/reactivity)：Signal / Memo / watch 的完整签名。
- [包与导出入口](/api/packages)：`@lania-v/runtime` 与 `@lania/store` / `@lania-v/advanced` 的分工。
- [增强组件 API](/api/enhanced-components)：`When` / `Each` / `KeepAlive` 等组件的入口位置。
