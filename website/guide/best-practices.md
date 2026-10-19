# 最佳实践

这一章是使用层面的建议，不涉及内部实现细节。

## 组件划分

### 让 `.lania.tsx` 只承载组件

```text
src/
├── components/
│   ├── TodoItem.lania.tsx
│   └── TodoList.lania.tsx
├── shared/
│   ├── todo-model.ts
│   └── todo-api.ts
└── main.ts
```

`.lania.tsx` 的模块输出会保留：

- 业务 import；
- 被编译产物引用到的模块级声明；
- 组件类。

未被引用的模块级声明不会进入产物。需要在多个组件间复用的逻辑，放到兄弟 `.ts` 文件再 import。

### props 类型显式声明

```tsx
type CardProps = {
  title: string;
  count?: number;
  onSelect?: (id: string) => void;
  children?: unknown;
};

export default defineComponent(function Card(props: CardProps) {
  return <h3>{props.title}</h3>;
});
```

好处：

- 编译器可以推导 prop 名单与 `observedAttributes`；
- `defineComponent` 的 `props` 选项可以按名字校验；
- 编辑器可以获得准确的 JSX 提示。

## 状态放置

| 状态 | 放在哪里 |
| --- | --- |
| 只影响当前组件 | 组件内 `createSignal()` |
| 多个组件共享 | 提升到共同父组件，通过 props / context 传递 |
| 复杂嵌套对象 | `createStore()` |
| 异步数据 | `createResource()` |
| 列表选中态 | `createSelector()` |
| 跨页面缓存 | `KeepAlive` 或外部 store |

### 不要把所有状态都放进 Store

```ts
// 不必要
const state = createStore({ count: 0, visible: true });

// 更直接
const count = createSignal(0);
const visible = createSignal(true);
```

Store 的优势是“按路径订阅”，不是“统一管理所有状态”。

### 派生值用 `createMemo`

```tsx
const items = createSignal<Item[]>([]);
const filter = createSignal<'all' | 'done'>('all');

const visibleItems = createMemo(() =>
  filter() === 'done' ? items().filter((item) => item.done) : items()
);
```

不要在模板里重复写昂贵的过滤逻辑：

```tsx
// 不推荐：每次更新都可能重新计算
<Each items={items().filter((item) => item.done)} />

// 推荐
<Each items={visibleItems()} />
```

## 列表

### 总是提供 key

```tsx
<Each items={rows()} key={(row) => row.id}>
  {(row) => <Row row={row} />}
</Each>
```

key 应该：

- 稳定；
- 唯一；
- 不随渲染顺序变化。

不要使用数组下标作为 key，除非列表只追加、不删除、不排序。

### 列表项内部状态

如果列表项有本地状态，key 变化会销毁旧节点并创建新节点。需要保留状态时：

- 使用稳定 key；
- 或把状态提升到父级。

## 事件

### 使用具名函数

```tsx
const onSubmit = () => {
  /* ... */
};

<button onClick={onSubmit}>submit</button>;
```

避免在 JSX 里写过长逻辑，既影响可读性，也不利于调试。

### 需要阻止冒泡时使用对象写法

```tsx
<button
  onClick={{
    handler: submit,
    modifiers: { stop: true, prevent: true },
  }}
/>
```

## 清理副作用

### 组件内

```tsx
let timer: ReturnType<typeof setInterval>;

onMount(() => {
  timer = setInterval(tick, 1000);
});

onCleanup(() => {
  clearInterval(timer);
});
```

或者只使用 `onCleanup()` 处理外部资源：

```tsx
onCleanup(() => {
  controller.abort();
});
```

### 组件外

```ts
const scope = createScope(() => {
  createEffect(() => {
    /* ... */
  });
});

scope.dispose();
```

## Context

完整用法见 [上下文（Context）](/guide/context)。

### 用默认值保证可用性

```ts
const ThemeContext = createContext<'light' | 'dark'>('light');
```

这样即使没有 provider，consumer 也能拿到合理默认值。

### provider 要挂在真实宿主上

在编译组件中使用两参 `provideContext(Context, value)`。它会改写成 `provideContext(this, ...)`，把上下文挂到当前自定义元素上。

## 表单

### 优先单向绑定

```tsx
<input value={draft()} onInput={(event) => draft.set(event.target.value)} />
```

需要双向绑定时使用 `model`：

```tsx
<input model={{ target: draft }} />
```

### 表单值参与原生提交

```tsx
useFormValue(() => account());
```

只有当组件需要出现在 `FormData` 中时才启用。不要给纯展示组件加 `formAssociated`。

## 样式

### 使用 `css` 与 Shadow DOM

```ts
const styles = css`
  :host {
    display: block;
  }
`;
```

- 组件内部样式默认隔离在 Shadow DOM；
- 需要穿透时使用 CSS 变量或 `::part`；
- `renderMode = 'light'` 会让样式进入全局作用域，谨慎使用。

### 不要依赖数值自动补单位

```tsx
style={{ width: `${width()}px` }}   // 正确
style={{ width: width() }}          // 会输出 width: 300;，无效
```

## SSR

### island props 必须可序列化

```tsx
<SearchBox client:visible query={query()} />
```

`query` 最终会进入 `data-lania-island-props`。不要传函数、类实例、Symbol。

### 合理选择优先级

| 内容 | 优先级 |
| --- | --- |
| 首屏关键交互 | `eager` |
| 首屏可见但非关键 | `visible` |
| 折叠区域 / 下方内容 | `idle` |
| 点击后才需要 | `interaction` |

## 调试

### 先看 renderPlan

遇到“更新了但界面没变”：

1. 开启 `debug: true`；
2. 查看 `renderPlan.textBindings` / `runtimeUpdaters`；
3. 确认表达式是否真的依赖了目标 Signal；
4. 用 `__lania.snapshot()` 确认 Updater 是否执行。

### 确认依赖是否被静态分析到

编译器对动态下标、复杂表达式可能只能保守分析。遇到依赖缺失时：

- 把读取显式提取为 `createMemo()`；
- 把 Store 路径写入改为稳定路径；
- 用 `getStorePathSignal()` 手动订阅。

## 性能

### 避免过早抽象

`lania-v` 的更新粒度已经很细。优先关注：

- 列表 key 是否稳定；
- 昂贵的派生值是否用 `createMemo()`；
- 大列表是否使用 `Virtual`；
- 长任务是否用 `startTransition()` / `defaultScheduler.createTransition()`。

### 不要把 Signal 读取放进不必要的循环

```tsx
// 每次 item 渲染都会读取 total
<Each items={items()}>
  {(item) => <Row total={total()} />}
</Each>
```

如果 `total` 只影响父级，提升到父级读取一次。

## 下一步

- [构建与部署](/guide/build-and-deploy)：把项目送上生产。
- [常见问题与排错](/guide/troubleshooting)：遇到问题时的排查顺序。
- [示例：Todo 列表](/examples/todo)
- [示例：登录表单](/examples/login)
- [整体架构](/advanced/architecture)
