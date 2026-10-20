# 状态管理

`lania-v` 不强制使用单一状态容器。小型状态直接用 `createSignal()`；对象型状态用 `createStore()`；列表选中态用 `createSelector()`。

## Signal 还是 Store

| 场景 | 选择 |
| --- | --- |
| 单个值 | `createSignal()` |
| 少量相关字段 | 多个 `createSignal()` |
| 嵌套对象 / 数组 | `createStore()` |
| 需要按字段路径精确订阅 | `createStore()` |
| 列表选中态 | `createSelector()` |

## `createStore()`

```ts
import { createStore } from '@lania-v/runtime';

const state = createStore({
  user: { name: 'Ada', age: 36 },
  list: [] as number[],
});

state.user.name; // 'Ada'
```

返回一个与 `createSignal()` 用法一致的句柄：

```ts
const state = createStore(initialValue, scheduler?);
```

| API | 作用 |
| --- | --- |
| `state.xxx` | 响应式只读读取；任意深度的嵌套字段按路径订阅 |
| `state.set(...)` | 唯一的写入入口 |
| `state.peek()` | 读取当前原始快照，不建立订阅 |

### 读取

```ts
state.user.name;
state.list.length;
state.list[0];
```

任意深度的字段都按路径精确订阅：读取 `state.user.name` 只订阅 `['user', 'name']`，不会因为兄弟字段变化而重跑。

### 写入

属性是**只读视图**，`state.user.name = 'Grace'` 会在运行时抛 `TypeError`，而不是静默失效：

```ts
state.user.name = 'Grace';
// TypeError: store.user.name is read-only.
// Use store.set("user.name", value) to update the store.
```

所有写入都必须走 `set()`；`set` 一律是**整体替换**，局部更新用嵌套路径：

```ts
// 整体替换（未给出的字段会被丢弃）
state.set({ user: { name: 'Grace' }, list: [] });

// 点路径写入（推荐用于局部更新）
state.set('user.name', 'Grace');

// 数组路径
state.set(['user', 'name'], 'Grace');

// 分段路径
state.set('user', 'name', 'Grace');

// 路径 + updater
state.set('user.age', (age: number) => age + 1);

// 数组
state.set('list', (list: number[]) => [...list, 1]);
state.set('list', 0, 99);
state.set('list.0.title', 'updated');
```

嵌套写入不需要手动展开整个对象：

```ts
const state = createStore({ user: { profile: { city: 'Paris' } }, page: 1 });

state.set('user.profile.city', 'Lyon');
// 只有 user.profile.city 变化，page 与其它兄弟字段保持原值
```

两个参数且首参是字符串时，首参按 `.` 拆成路径；三个及以上参数保持分段路径语义。
路径不存在时会按需创建中间对象。

路径写入采用**沿路径浅拷贝**的不可变更新策略：

1. 复制根对象；
2. 复制路径上的每一层容器；
3. 只替换目标字段。

因此：

```ts
const before = state.user;
state.set('user.name', 'Grace');
const after = state.user;

before !== after; // true
```

### 方法调用

Store 中的方法会自动绑定到所属对象，因此 `this` 指向正确路径，但 `this` 同样是只读视图：

```ts
const state = createStore({
  count: 1,
  increment() {
    // ❌ 编译与运行时都不允许：this 是只读视图
    // this.count += 1;
    this.set('count', (count: number) => count + 1);
  },
});

state.increment();
```

方法里需要写入时，请显式调用 `set()`（如上）；这里的 `this.set` 会写入当前路径下的字段。

### `peek()`

```ts
const snapshot = state.peek();
```

`peek()` 返回当前原始对象且不建立订阅，适合事件回调、日志等非渲染场景。

### 其他状态方法

| API | 作用 |
| --- | --- |
| `state.get('a.b')` | 按路径读取单个值（支持动态路径） |
| `state.has('a.b')` | 路径是否存在 |
| `state.keys()` / `state.entries()` | 浅层快照遍历 |
| `state.update('a.b', fn)` | 路径更新，`fn` 必须返回新值 |
| `state.delete('a.b')` | 删除路径 |
| `state.patch({ ... })` | 显式浅合并（`set` 是整体替换） |
| `state.reset()` | 恢复到创建时的初始值 |
| `state.subscribe(fn)` | 任意变化时回调，返回取消订阅函数 |
| `state.subscribe('a.b', fn)` | 只订阅某个路径 |
| `state.derive(fn)` | 从 store 派生只读 memo |

```ts
const unsubscribe = state.subscribe('user.name', (next) => {
  console.log('name is now', next);
});

state.update('user.age', (age: number) => age + 1);
state.patch({ theme: 'dark' });   // 只覆盖给出的字段
state.delete('user.nickname');
unsubscribe();
```

### `__raw`

需要读取当前路径的原始值时，可以使用 `__raw`：

```ts
const raw = state.user.__raw;
```

这是内部逃生口，业务代码应优先保持响应式读取。

### 等值语义

Signal 层使用 `Object.is()`。因此：

```ts
state.set('user', 'name', 'Ada'); // 值没变，不会触发订阅者
```

## `produce()`

`produce()` 用**纯函数**计算下一个状态：`draft` 是只读快照，回调必须有返回值，返回值作为新状态整体写回。

```ts
import { createStore, produce } from '@lania-v/runtime';

const state = createStore({
  list: [] as number[],
  user: { name: 'Ada' },
});

produce(state, (draft) => ({
  ...draft,
  list: [...draft.list, 1],
  user: { ...draft.user, name: 'Grace' },
}));
```

约束：

- `draft` 只读，回调内直接赋值/`push` 会抛错；
- 必须返回新的状态对象，返回 `undefined` 会抛错；
- 需要局部更新时，用 `state.set('path', value)` 更直接。

实现细节：

- 优先使用 `structuredClone()` 生成草稿；
- 数据包含函数 / 类实例等不可克隆值时退回浅拷贝；
- 退回浅拷贝时，深层修改可能不会按路径精确通知，建议改用路径写法。

## 按路径订阅

Store 的读取本身就是路径级的：读到哪条路径，就只订阅那条路径。

```ts
import { createStore, createEffect, watch } from '@lania-v/runtime';

const state = createStore({ user: { name: 'Ada' }, count: 0 });

createEffect(() => {
  console.log(state.user.name);
});

state.set('user.name', 'Grace'); // effect 触发
state.set('count', 1);           // 不触发
```

需要新旧值时用 `watch` 的 getter 形式：

```ts
watch(
  () => state.user.name,
  (current, previous) => {
    console.log(previous, '->', current);
  }
);
```

这在编写 composable 或需要手动订阅路径时很有用，不需要额外的路径 API。

## `createSelector()`

常见写法：

```tsx
<Each items={items()}>
  {(item) => (
    <Row selected={selectedId() === item.id} />
  )}
</Each>
```

这会让每个 `Row` 都订阅 `selectedId`。一次选中变化会触发整列表的更新。

`createSelector()` 把每个 key 的布尔结果独立成一个小 Signal：

```ts
import { createSelector, createSignal } from '@lania-v/runtime';

const selectedId = createSignal<string | null>(null);
const isSelected = createSelector(selectedId);

isSelected('a'); // false
selectedId.set('a');
isSelected('a'); // true
```

模板里：

```tsx
<Each items={items()}>
  {(item) => <Row selected={isSelected(item.id)} />}
</Each>
```

只有选中态真正变化的 key 会更新。

自定义比较：

```ts
const isCurrent = createSelector(currentUser, (key, value) => key.id === value?.id);
```

释放：

```ts
onCleanup(() => isSelected.dispose());
```

`createSelector` 内部使用一个 `createEffect`，但它是通过运行时函数创建的，不会被编译器当作组件级 effect 改写。因此在组件内使用时请显式 `dispose()`（例如在 `onCleanup()` 中），或把它放进 `createScope()`。

## 组合示例

```tsx
import {
  createMemo,
  createSelector,
  createSignal,
  createStore,
  defineComponent,
  Each,
  onCleanup,
  produce,
} from '@lania-v/runtime';

type Todo = { id: string; text: string; done: boolean };

export default defineComponent(function TodoApp() {
  const state = createStore({
    todos: [] as Todo[],
    filter: 'all' as 'all' | 'active' | 'done',
  });

  const draft = createSignal('');
  const selectedId = createSignal<string | null>(null);
  const isSelected = createSelector(selectedId);

  onCleanup(() => isSelected.dispose());

  const visibleTodos = createMemo(() => {
    const filter = state.filter;
    if (filter === 'active') return state.todos.filter((todo) => !todo.done);
    if (filter === 'done') return state.todos.filter((todo) => todo.done);
    return state.todos;
  });

  const add = () => {
    const text = draft.value.trim();
    if (!text) return;

    produce(state, (previous) => ({
      ...previous,
      todos: [...previous.todos, { id: crypto.randomUUID(), text, done: false }],
    }));
    draft.set('');
  };

  return (
    <section>
      <input model={{ target: draft }} onKeyDown={(event) => event.key === 'Enter' && add()} />

      <select
        model={{
          source: {
            get: () => state.filter,
            set: (value) => state.set('filter', value as 'all' | 'active' | 'done'),
          },
        }}
      >
        <option value="all">All</option>
        <option value="active">Active</option>
        <option value="done">Done</option>
      </select>

      <Each items={visibleTodos.value} key={(todo) => todo.id}>
        {(todo) => (
          <div className={isSelected(todo.id) ? 'row is-selected' : 'row'}>
            <input
              type="checkbox"
              model={{
                source: {
                  get: () => todo.done,
                  set: () =>
                    state.set('todos', (list) =>
                      list.map((entry) =>
                        entry.id === todo.id ? { ...entry, done: !entry.done } : entry
                      )
                    ),
                },
              }}
            />
            <span>{todo.text}</span>
            <button onClick={() => selectedId.set(todo.id)}>select</button>
          </div>
        )}
      </Each>
    </section>
  );
});
```

::: tip
`model` 的 `source` 形式适合把 Store 路径包装成可读写句柄。如果只是单向展示，直接读取即可。
:::

## 下一步

- [响应式 API](/api/reactivity)：`createStore` / `produce` / `createSelector` 的完整签名。
- [过渡与缓存](/guide/transitions-and-cache)：低优先级列表更新与 `TransitionGroup`。
- [更新链路](/advanced/update-pipeline)：Store 路径 Signal 如何进入调度器。
