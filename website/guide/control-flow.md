# 条件与列表

条件、列表、动态组件和 Teleport 都由**增强组件**表达。它们在编译期会被识别，并下沉为对应的结构块。

## `When`

```tsx
<When when={visible()} fallback={<p>hidden</p>}>
  <p>visible</p>
</When>
```

Props：

```ts
interface WhenProps {
  when: boolean;
  fallback?: EnhancedRenderable;
  mode?: 'retain' | 'remount';
  children?: unknown;
}
```

`mode` 控制条件切换时的节点策略：

| 模式 | 行为 |
| --- | --- |
| `remount`（默认） | 分支切换时销毁并重建 |
| `retain` | 分支隐藏时保留节点，再次显示时复用 |

需要重置内部状态（例如表单、滚动位置、子组件状态）时使用 `remount`：

```tsx
<When when={tab() === 'form'} mode="remount">
  <ExpensiveForm />
</When>
```

### `Then` / `Else`

`Then` / `Else` 只能作为 `<When>` 的**直接子节点**：

```tsx
<When when={ready()}>
  <Then>
    <Result />
  </Then>
  <Else>
    <Skeleton />
  </Else>
</When>
```

它们本身不产生运行时节点，只是帮助编译器建立分支结构。

## `Switch` / `Case` / `Default`

```tsx
<Switch mode="retain">
  <Case when={status() === 'loading'}>
    <Spinner />
  </Case>
  <Case when={status() === 'error'}>
    <ErrorView />
  </Case>
  <Default>
    <Content />
  </Default>
</Switch>
```

约束：

- `Case` / `Default` 只能作为 `<Switch>` 的直接子节点；
- `Switch` 会按顺序生成嵌套条件分支；
- 第一个为真的 `Case` 生效；
- `Default` 作为兜底。

## `Each`

```tsx
<Each
  items={todos()}
  key={(item) => item.id}
  fallback={<p>No todos</p>}
>
  {(item, index) => (
    <div>
      <span>{index + 1}.</span>
      <span>{item.text}</span>
    </div>
  )}
</Each>
```

Props：

```ts
interface EachProps<T> {
  items: readonly T[] | null | undefined;
  key?: (item: T, index: number) => PropertyKey;
  fallback?: EnhancedRenderable;
  children:
    | ((item: T, index: number) => EnhancedRenderable)
    | EnhancedRenderable;
}
```

行为：

- `items` 为空或 `null` / `undefined` 时渲染 `fallback`；
- 提供 `key` 时走 keyed 模式，按 key 复用节点；
- 不提供 `key` 时按下标协调；
- children 是函数时按 `(item, index)` 调用。

### 为什么需要 key

```tsx
<Each items={rows()} key={(row) => row.id}>
  {(row) => <Row row={row} />}
</Each>
```

没有 key 时，插入或删除中间项会让后续所有节点的内容重新写入。keyed 模式会：

1. 按 key 建立旧节点索引；
2. 只创建新增项；
3. 移动复用项；
4. 移除消失项。

## `Dynamic`

`Dynamic` 按运行时值选择标签或组件：

```tsx
<Dynamic is={tag()} fallback={<span>unknown</span>}>
  content
</Dynamic>

<Dynamic
  component={Widget}
  props={{ title: title() }}
  fallback={<span>no widget</span>}
/>
```

Props：

```ts
interface DynamicProps {
  is?: unknown;
  component?: unknown;
  props?: Record<string, unknown>;
  fallback?: EnhancedRenderable;
  children?: unknown;
}
```

- `is` 用于标签名或组件；
- `component` 用于组件引用；
- `props` 会作为组件属性传入；
- 无法解析时渲染 `fallback`。

## `Slot`

`Slot` 读取当前运行时作用域的插槽内容：

```tsx
<Slot name="header" fallback={<h2>默认标题</h2>} />

<Slot args={item} fallback={<span>empty</span>} />
```

::: warning 适用范围
`<Slot>` 面向运行时 JSX 路径（`jsx(Child, { children })`）。在 `.lania.tsx` 编译组件中请使用
`bindSlots()`，两种路径的差异见 [插槽](/guide/slots#编译组件与运行时-jsx)。
:::

```ts
interface SlotProps {
  name?: string;
  fallback?: EnhancedRenderable;
  /** 传给函数型 slot 的参数；数组会按位置展开。 */
  args?: unknown;
  children?: unknown;
}
```

当插槽内容是函数时，`args` 会作为参数传入：

```tsx
// 父组件（运行时 JSX）
<Child>{(item: Item) => <Row item={item} />}</Child>;

// 子组件
<Slot args={item} />;
```

## `Fragment`

`Fragment` 不产生额外节点，只用于组合多个根：

```tsx
<Fragment>
  <dt>{term()}</dt>
  <dd>{definition()}</dd>
</Fragment>
```

## `Teleport`

`Teleport` 把子树渲染到指定容器：

```tsx
<Teleport to="#portal-root">
  <div className="toast">saved</div>
</Teleport>
```

`to` 支持：

- 选择器字符串；
- `Element`；
- `null` / `undefined`（不渲染）。

```ts
interface TeleportProps {
  to: string | Element | null | undefined;
  children?: unknown;
}
```

SSR 阶段会输出 teleport 容器 marker，客户端 hydration 时重新接管。

## 编译期约束

增强组件不是普通组件，编译器会为它们做结构校验：

| 写法 | 结果 |
| --- | --- |
| `<Then>` 不在 `<When>` 下 | 编译错误 |
| `<Else>` 不在 `<When>` 下 | 编译错误 |
| `<Case>` / `<Default>` 不在 `<Switch>` 下 | 编译错误 |
| 在增强组件上使用任意未知 prop | 取决于组件，通常会被忽略或参与 metadata |

增强组件注册表位于 `@lania-v/shared`，编译器和运行时共享同一份定义：

```ts
import {
  ENHANCED_COMPONENT_NAMES,
  getEnhancedComponentRegistryEntry,
} from '@lania-v/shared';

getEnhancedComponentRegistryEntry('Each');
// { name: 'Each', category: 'structure', irKind: 'ListIR', ... }
```

## 下一步

- [异步与边界](/guide/async-and-boundaries)：`Suspense`、`ErrorBoundary`、`LazyLoad`、`Await`。
- [过渡与缓存](/guide/transitions-and-cache)：`Transition`、`TransitionGroup`、`KeepAlive`。
- [增强组件 API](/api/enhanced-components)：完整 props 表。
