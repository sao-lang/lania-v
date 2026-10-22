# 插槽

`lania-v` 里的 “Slot” 有两个含义，先分清：

- **组件插槽**（本文）：父组件传给子组件的内容，例如默认槽、具名槽、作用域槽；
- **运行时更新槽**：编译器为每个动态位置分配的写入单元，
  例如 `TextSlot`、`IfSlot`；见 [编译模型](/guide/compilation-model) 与
  [DOM 与绑定 API](/api/dom)。

两者没有直接关系。

## 快速开始

子组件用 `bindSlots()` 读取插槽：

```tsx
import { bindSlots, defineComponent } from '@lania-v/runtime';

export default defineComponent(function Panel(props: { children?: unknown }) {
  const slots = bindSlots();

  return (
    <section>
      <header>{slots.render('header', <h2>默认标题</h2>) as any}</header>
      <main>{slots.renderDefault(<p>没有内容</p>) as any}</main>
    </section>
  );
});
```

父组件显式传入 `children` 对象：

```tsx
<Panel
  children={{
    header: <h2>标题</h2>,
    default: <p>正文</p>,
  }}
/>
```

::: warning 普通子节点不会自动进入 `props.children`
在 `.lania.tsx` 编译组件中，`<Panel><p>正文</p></Panel>` 的子节点会作为宿主的
light DOM / childBindings 渲染，**不会**写入 `props.children`，因此
`bindSlots()` 读不到它们。要在编译组件里按逻辑读取插槽，请像上面一样显式传
`children={...}`。
:::

## 内容协议

`bindSlots(props?)` 优先读取当前 runtime scope 的 `slotContent`；编译组件里编译器会把
`bindSlots()` 改写成 `bindSlots(this.props)`，从 `props.children` 读取。

| `children` 形态                     | 默认槽    | 具名槽    | 函数型（作用域）     |
| ----------------------------------- | --------- | --------- | -------------------- |
| 普通值 / 节点 / 数组                | 整个值    | 无        | 否                   |
| 普通对象 `{ default, header, ... }` | `default` | 按 key 取 | 值为函数时按函数处理 |
| 函数                                | 函数本身  | 无        | 是                   |

## API 语义

```ts
interface SlotBindings {
  has(name?: string): boolean;
  get(name?: string): unknown;
  render(name: string, fallback?: unknown, ...args: unknown[]): unknown;
  renderDefault(fallback?: unknown, ...args: unknown[]): unknown;
}
```

| 方法            | 说明                                             |
| --------------- | ------------------------------------------------ |
| `render`        | 解析顺序见下；函数型槽会带 `args` 调用           |
| `renderDefault` | `children.default ?? fallback`                   |
| `get(name)`     | `children[name] ?? children.default`；不调用函数 |
| `has(name)`     | 只检查具名槽本身，不被 `default` 兜底            |

`render(name, fallback, ...args)` 的解析顺序：
`children[name] ?? children.default ?? fallback`。

::: tip `render` 的 `fallback` 可能不会生效
如果只提供了默认槽，`render('footer', 'fallback')` 会返回默认槽内容，而不是
`'fallback'`。需要严格判断具名槽是否存在时，先用 `has(name)`。
:::

## 具名插槽

```tsx
const slots = bindSlots();

slots.has('footer'); // 只判断 footer 槽本身
slots.render('footer', 'fallback');
```

编译组件的具名槽通过对象协议传递：

```tsx
<Panel
  children={{
    header: <h2>标题</h2>,
    footer: <small>底部</small>,
    default: <p>正文</p>,
  }}
/>
```

也可以写 `slot` 属性：

```tsx
<Panel>
  <h2 slot="header">标题</h2>
  <p>正文</p>
</Panel>
```

上面的写法依赖浏览器的原生 `<slot>` 投影，只在 Shadow DOM 宿主下生效；它不会写入
`props.children`，所以 `bindSlots().has('header')` 仍为 `false`。需要逻辑判断时请使用
对象协议。

## 作用域插槽

插槽内容是函数时，`render()` / `renderDefault()` 的额外参数会按位置传入：

```tsx
// 子组件
const slots = bindSlots();
return <div>{slots.renderDefault('empty', item) as any}</div>;

// 父组件
<Child children={(item: string) => <span>{item}</span>} />;
```

`get()` 和 `has()` 不会调用函数；只有 `render()` / `renderDefault()` 会调用。

## 编译组件与运行时 JSX

| 场景                                     | 推荐写法                              |
| ---------------------------------------- | ------------------------------------- |
| `.lania.tsx` 编译组件                    | `bindSlots()` + 显式 `children={...}` |
| 运行时 JSX（`jsx(Child, { children })`） | `bindSlots()` 或 `<Slot>`             |
| 需要浏览器原生投影                       | Shadow DOM + 子节点上的 `slot="name"` |

`<Slot>` 读取的是当前 runtime scope 的 `slotContent`，因此它是**运行时 JSX 路径**的占位组件。
`.lania.tsx` 编译组件内没有这份 scope，请使用 `bindSlots()`。

## Shadow DOM 与 light DOM

- **默认 Shadow DOM**：`render()` / `renderDefault()` 可能返回原生 `<slot>` 元素，由浏览器完成
  light DOM 投影。请把它当作可渲染值使用，不要依赖具体节点类型。
- **`renderMode: 'light'`**：没有原生投影，`render()` 直接展开 `children` 中的内容；运行时不解析
  子节点上的 `slot` 属性。

因此，子节点上的 `slot="header"` 与 `children` 对象协议是两条不同的路径：

| 写法                   | 读取方式               | `has('header')` |
| ---------------------- | ---------------------- | --------------- |
| `children` 对象        | `bindSlots()` 逻辑读取 | `true`          |
| 子节点 `slot="header"` | 浏览器原生投影         | `false`         |

## 常见问题

### 为什么 `has('header')` 是 `false`？

- 没有显式传 `children` 对象；
- 或使用了子节点 `slot="header"`，走的是原生投影而不是 `props.children`。

### 为什么 fallback 没有出现？

具名槽缺失但默认槽存在时，`render(name, fallback)` 会使用默认槽内容。先用 `has(name)` 判断，
或直接调用 `render` 并接受这个回退规则。

### 子组件需要声明 `children` 吗？

编译组件会把 `children` 作为 prop 写入实例，建议在 props 类型里声明 `children?: unknown`：

```tsx
type PanelProps = {
  children?: unknown;
};
```

## 下一步

- [组件](/guide/components)
- [条件与列表](/guide/control-flow)
- [组件 API](/api/component)
