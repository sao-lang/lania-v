# 示例：Todo 列表

这个示例来自 `playground/todo/src/TodoFc.lania.tsx`，覆盖：

- Signal / Memo；
- 列表过滤；
- `Each` + key；
- 事件绑定；
- 组件样式。

## 完整代码

```tsx
import {
  createMemo,
  createSignal,
  defineComponent,
  Each,
} from '@lania-v/runtime';

type TodoItem = {
  id: string;
  text: string;
  completed: boolean;
};

type TodoFilter = 'all' | 'active' | 'completed';

let nextId = 0;
const createTodoId = () => `todo-${++nextId}`;

export default defineComponent(function TodoFc() {
  const normalizeText = (value: string) => value.trim().replace(/\s+/g, ' ');

  const todos = createSignal<TodoItem[]>([
    { id: createTodoId(), text: 'FC: return TSX', completed: false },
    { id: createTodoId(), text: 'FC: list via Each', completed: true },
  ]);
  const draft = createSignal('');
  const filter = createSignal<TodoFilter>('all');

  const remainingCount = createMemo(
    () => todos().filter((item) => !item.completed).length
  );

  const filteredTodos = createMemo(() => {
    const current = filter();
    const items = todos();

    if (current === 'active') return items.filter((item) => !item.completed);
    if (current === 'completed') return items.filter((item) => item.completed);
    return items;
  });

  const addTodo = () => {
    const text = normalizeText(draft());
    if (!text) return;

    todos.set((prev) => [
      ...prev,
      { id: createTodoId(), text, completed: false },
    ]);
    draft.set('');
  };

  const toggleTodo = (id: string) => {
    todos.set((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, completed: !item.completed } : item
      )
    );
  };

  const removeTodo = (id: string) => {
    todos.set((prev) => prev.filter((item) => item.id !== id));
  };

  const clearCompleted = () => {
    todos.set((prev) => prev.filter((item) => !item.completed));
  };

  return (
    <section className="todo-card">
      <header>
        <h3>Todo List</h3>
      </header>

      <div className="row">
        <input
          className="input"
          placeholder="What needs to be done?"
          value={draft()}
          onInput={(event) => {
            const target = event.target as HTMLInputElement | null;
            draft.set(target?.value ?? '');
          }}
          onKeyDown={(event) => {
            if ((event as KeyboardEvent).key === 'Enter') addTodo();
          }}
        />
        <button className="btn" onClick={addTodo}>
          Add
        </button>
      </div>

      <div className="filters">
        <button
          className="chip"
          aria-pressed={filter() === 'all'}
          onClick={() => filter.set('all')}
        >
          All
        </button>
        <button
          className="chip"
          aria-pressed={filter() === 'active'}
          onClick={() => filter.set('active')}
        >
          Active
        </button>
        <button
          className="chip"
          aria-pressed={filter() === 'completed'}
          onClick={() => filter.set('completed')}
        >
          Completed
        </button>
      </div>

      <div className="list">
        <Each
          items={filteredTodos()}
          key={(item) => item.id}
          fallback={<p className="empty">No todos</p>}
        >
          {(item) => (
            <div className="item">
              <input
                type="checkbox"
                checked={item.completed}
                onChange={() => toggleTodo(item.id)}
              />
              <span className={item.completed ? 'done' : ''}>{item.text}</span>
              <button className="danger" onClick={() => removeTodo(item.id)}>
                Delete
              </button>
            </div>
          )}
        </Each>
      </div>

      <footer className="footer">
        <span className="summary">{remainingCount()} item(s) left</span>
        <button className="btn" onClick={clearCompleted}>
          Clear completed
        </button>
      </footer>
    </section>
  );
});
```

## 逐段解释

### 状态

```ts
const todos = createSignal<TodoItem[]>([]);
const draft = createSignal('');
const filter = createSignal<TodoFilter>('all');
```

三个 Signal 分别表示：

- 列表数据；
- 输入框草稿；
- 过滤条件。

### 派生值

```ts
const remainingCount = createMemo(
  () => todos().filter((item) => !item.completed).length
);
```

`remainingCount` 只依赖 `todos`。`todos.set()` 会让它重新计算。

```ts
const filteredTodos = createMemo(() => {
  const current = filter();
  const items = todos();
  // ...
});
```

`filteredTodos` 同时依赖 `filter` 与 `todos`。

### 列表

```tsx
<Each items={filteredTodos()} key={(item) => item.id}>
  {(item) => <div>...</div>}
</Each>
```

编译器会把 `Each` 下沉为 `ListIR`：

- `items` 变化时重新协调；
- `key` 用于复用节点；
- children 函数会在每个 item 上调用。

### 事件

```tsx
onClick={() => removeTodo(item.id)}
```

编译成事件 Slot。事件委托开启后，同一 root 的 `click` 只挂一条原生监听。

### class 绑定

```tsx
<span className={item.completed ? 'done' : ''}>{item.text}</span>
```

只写入 class attribute，不影响文本 Slot。

## 编译产物关注点

开启 `debug: true` 后可以观察：

```js
__laniaCompile.TodoFc.renderPlan.listBindings;
__laniaCompile.TodoFc.renderPlan.textBindings;
__laniaCompile.TodoFc.renderPlan.runtimeUpdaters;
```

重点：

- `listBindings` 中的 keyed 模板；
- `textBindings` 中的 `remainingCount()`；
- `runtimeUpdaters` 的依赖集合。

## 可以继续练习

1. 把 `todos` 换成 `@lania-v/store` 的 `createAtom`，按路径更新；
2. 用 `createSelector` 优化选中态；
3. 给 `Each` 加 `TransitionGroup` 做增删动画；
4. 用 `createResource` 从接口加载初始数据。
