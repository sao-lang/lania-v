# 组件

在 `lania-v` 中，一个组件既是函数组件，也是一个 Custom Element 类。`defineComponent()` 负责把两者关联起来。

## 定义组件

```tsx
import { createSignal, defineComponent } from '@lania-v/runtime';

export default defineComponent(function Counter() {
  const count = createSignal(0);

  return <button onClick={() => count.set((value) => value + 1)}>count: {count.value}</button>;
});
```

也支持先声明再导出：

```tsx
const Counter = defineComponent(function Counter() {
  /* ... */
});

export default Counter;
```

### 标签名

编译产物会根据组件名推导标签名：

| 组件名 | 标签 |
| --- | --- |
| `Counter` | `x-counter` |
| `TodoList` | `todo-list` |
| `MyCard`（显式 `tagName`） | `my-card` |

推导规则：

1. 优先使用 `static tagName`；
2. 其次使用 `static displayName`；
3. 最后使用类名 / 函数名；
4. 转成 kebab-case；
5. 没有连字符时补 `x-` 前缀；
6. 以 `xml` 开头时补 `x-` 前缀。

## `defineComponent(fn, options)`

```tsx
export default defineComponent(function FancyInput(props: FancyInputProps) {
  return <div>{props.count}</div>;
}, {
  props: {
    count: { type: Number, reflect: true, default: 0 },
    userName: { type: String, attribute: 'user-name' },
    onSelect: { attribute: false },
  },
  emits: ['select'],
});
```

第二个参数只被编译器读取，运行时会把它原样保留在类上：

```ts
static __laniaOptions = { props, emits };
static propOptions = resolvePropOptions(this.__laniaOptions?.props);
static emits = this.__laniaOptions?.emits;
```

因此选项里可以引用模块级常量、导入的函数，甚至展开对象：

```tsx
import { SHARED_PROPS, EVENTS, convertLevel } from './props-config';

export default defineComponent(function Field(props: FieldProps) {
  return <div>{props.level}</div>;
}, {
  props: {
    ...SHARED_PROPS,
    level: { converter: { from: convertLevel } },
  },
  emits: EVENTS,
});
```

### Prop 选项

```ts
interface PropOption {
  type?: StringConstructor | NumberConstructor | BooleanConstructor | ObjectConstructor | ArrayConstructor;
  attribute?: string | false;
  reflect?: boolean;
  default?: unknown;
  converter?: {
    from?: (value: string | null) => unknown;
    to?: (value: unknown) => string | null;
  };
  validator?: (value: unknown) => boolean;
}
```

| 选项 | 说明 |
| --- | --- |
| `type` | attribute 字符串的回读类型 |
| `attribute` | 自定义 attribute 名；`false` 表示不同步 |
| `reflect` | prop 变化时是否写回 attribute |
| `default` | 初始值，优先于类型推导 |
| `converter.from` | attribute → prop |
| `converter.to` | prop → attribute |
| `validator` | 开发态校验，失败输出 warning |

未声明 `attribute` 时按 kebab-case 映射：

```text
userName   → user-name
maxCount   → max-count
title      → title
```

`attribute: false` 的 prop 不会进入 `observedAttributes`，也不会反射。

### 事件声明

```tsx
export default defineComponent(function Selector() {
  return <div />;
}, {
  emits: ['select', 'clear'],
});
```

在开发模式下，调用 `emit()` 派发未声明事件会输出 warning。

## 访问 props

在编译组件里，`props` 不是普通对象，而是一份**属性快照**：每个 prop 的 getter 都回读实例上的同名 Signal。

```tsx
function Card(props: { title: string; count: number }) {
  return (
    <div>
      {props.title}
      {props.count}
    </div>
  );
}
```

### 解构

支持在组件体顶层解构：

```tsx
function Card(props: CardProps) {
  const { title, count: total, user: { name, age = 0 }, ...rest } = props;

  return (
    <div>
      {title} {total} {name} {age}
    </div>
  );
}
```

编译后会映射回实例属性：

```text
title          → this.title
count: total   → this.count（total 只是别名）
user.name      → this.user?.name
...rest        → this.rest
```

支持的形态：

- 内联对象类型；
- 同文件 `type` / `interface`（含 `extends`）；
- 交叉类型；
- 相对路径导入的具名类型。

暂不支持：

- 包名或路径别名导入的 props 类型；
- 需要类型检查器展开的 `Pick<T, K>`、泛型实例化等；
- 计算属性名。

## 生命周期

函数组件只保留三个正式钩子：

```tsx
import { defineComponent, onCleanup, onMount, onUpdated } from '@lania-v/runtime';

export default defineComponent(function Panel() {
  onMount(() => {
    console.log('mounted');
  });

  onCleanup(() => {
    console.log('unmounted');
  });

  onUpdated((changedProps) => {
    console.log('updated', [...changedProps.keys()]);
  });

  return <div />;
});
```

| Hook | 触发时机 |
| --- | --- |
| `onMount()` | 首次连接并准备挂载时 |
| `onCleanup()` | 断开连接 / 卸载时 |
| `onUpdated(changedProps)` | 每次更新完成后 |

兼容别名：

- `onMounted` → `onMount`
- `onUnmounted` → `onCleanup`

::: warning 编译期标记
这些 API 只作为编译器识别标记存在。它们必须在 `.lania.tsx` 编译链中被改写；直接在未编译的运行时里调用会抛出 compile-only 错误。
:::

### 手写 `ReactiveElement`

如果需要完全控制生命周期，可以直接继承 `ReactiveElement`：

```ts
import { ReactiveElement } from '@lania-v/runtime';

class MyElement extends ReactiveElement {
  static tagName = 'my-element';
  static renderMode = 'shadow';

  protected _renderAndMount(): void {
    this.renderRoot.textContent = 'hello';
  }

  connectedCallback(): void {
    super.connectedCallback();
  }

  protected willUpdate(changedProps) {
    super.willUpdate(changedProps);
  }

  protected updated(changedProps) {
    super.updated(changedProps);
  }

  protected firstUpdated() {
    console.log('first update');
  }
}

customElements.define('my-element', MyElement);
```

可覆写的生命周期：

| 方法 | 说明 |
| --- | --- |
| `connectedCallback()` | 连接 DOM |
| `disconnectedCallback()` | 断开 DOM |
| `attributeChangedCallback()` | observed attribute 变化 |
| `adoptedCallback()` | 文档迁移 |
| `shouldUpdate(changedProps)` | 返回 `false` 可跳过更新 |
| `willUpdate(changedProps)` | 更新前 |
| `updated(changedProps)` | 更新后 |
| `firstUpdated(changedProps)` | 首次更新后 |

更新顺序：

```text
requestUpdate
  → shouldUpdate
  → willUpdate
  → flushUpdaters
  → updated
  → firstUpdated（仅首次）
```

`changedProps` 的类型：

```ts
type ChangedProps = Map<string, { previous: unknown; current: unknown }>;
```

### 主动请求更新

```ts
this.requestUpdate();
this.requestUpdate('count', previous, current);
```

同一微任务内的多次请求会合并为一次 `performUpdate()`。

## 派发事件

`ReactiveElement` 提供 `emit()`：

```ts
class MyPicker extends ReactiveElement {
  select(id: string) {
    this.emit('select', { id });
  }
}

// 默认 bubbles + composed，可被外层监听
element.addEventListener('select', (event) => {
  console.log((event as CustomEvent).detail);
});
```

```ts
emit<T>(
  name: string,
  detail?: T,
  options?: Omit<CustomEventInit<T>, 'detail'>
): boolean;
```

默认值：

- `bubbles: true`
- `composed: true`
- `cancelable: false`

`emits` 声明只做开发态校验，不会阻止事件派发。

## 插槽

完整协议见 [插槽](/guide/slots)；这里只列最常用的入口。

### `props.children`

最简单的插槽读取方式：父组件显式传入 `children`。

```tsx
function Panel(props: { children?: unknown }) {
  return <section>{props.children as any}</section>;
}
```

### `bindSlots()`

`bindSlots()` 提供默认槽、具名槽与 fallback：

```tsx
import { bindSlots, defineComponent } from '@lania-v/runtime';

export default defineComponent(function Panel(props: { children?: unknown }) {
  const slots = bindSlots();

  return (
    <section>
      <header>{slots.render('header', <h2>默认标题</h2>) as any}</header>
      <main>{slots.renderDefault(<p>没有内容</p>) as any}</main>
      {slots.has('footer') ? <footer>{slots.render('footer') as any}</footer> : null}
    </section>
  );
});
```

API：

```ts
interface SlotBindings {
  has(name?: string): boolean;
  get(name?: string): unknown;
  render(name: string, fallback?: unknown, ...args: unknown[]): unknown;
  renderDefault(fallback?: unknown, ...args: unknown[]): unknown;
}
```

- `render(name, fallback)` 的解析顺序是 `children[name] ?? children.default ?? fallback`；
- `has(name)` 只判断具名槽本身是否存在，不会被默认槽兜底；
- 编译产物会把 `bindSlots()` 改写成 `bindSlots(this.props)`，从 `children` prop 读取；
- `render()` / `renderDefault()` 的额外参数会透传给函数型 slot。

### 具名插槽

编译组件不会把普通子节点写进 `props.children`，具名槽需要显式传对象：

```tsx
<Panel
  children={{
    header: <h2>标题</h2>,
    footer: <small>底部</small>,
    default: <p>默认内容</p>,
  }}
/>
```

子节点上的 `slot="header"` 是浏览器原生投影语法，只在 Shadow DOM 宿主下生效，
`bindSlots().has('header')` 读不到它。两条路径的区别见
[插槽 · Shadow DOM 与 light DOM](/guide/slots#shadow-dom-与-light-dom)。

### Scoped slot

当 `children` 是函数时，额外参数会按位置传入：

```tsx
// 子组件
const slots = bindSlots();
return <div>{slots.renderDefault('empty', item) as any}</div>;

// 父组件
<Child children={(item: string) => <span>{item}</span>} />;
```

`<Slot>` 是运行时 JSX 路径的占位组件；`.lania.tsx` 编译组件内请使用 `bindSlots()`
（见 [插槽 · 编译组件与运行时 JSX](/guide/slots#编译组件与运行时-jsx)）。

## `createExpose()`

`createExpose()` 定义组件暴露给父组件 ref 的公开面：

```tsx
import { createExpose, createRef, defineComponent } from '@lania-v/runtime';

type PanelExpose = {
  focusInput(): void;
  clearInput(): void;
};

type PanelProps = {
  ref?: PanelExpose;
  children?: unknown;
};

export default defineComponent(function Panel(props: PanelProps) {
  const inputRef = createRef<HTMLInputElement>();

  createExpose(props, {
    focusInput: () => {
      inputRef?.focus();
    },
    clearInput: () => {
      if (inputRef) {
        inputRef.value = '';
      }
    },
  });

  return <input ref={inputRef} />;
});
```

父组件：

```tsx
const panelRef = createRef<PanelExpose>();

<Panel ref={panelRef} />;

panelRef?.focusInput();
```

`createExpose()` 建立在现有 `ref` 通道上，不会引入新的组件实例系统。组件替换内容或卸载时会自动把 ref 置空。

::: tip 用箭头函数声明暴露方法
编译器会把组件内的本地引用改写成 `this.xxx`，而普通对象方法的 `this` 不是组件实例。
因此 `createExpose()` 的回调请写成箭头函数属性（`focusInput: () => {}`）。
:::

## `bindProps()` 与 `bindHandlers()`

普通属性与回调属性在同一个 `props` 上。`bindProps()` / `bindHandlers()` 提供分流视图，
**不需要把 `props` 传进去**，直接调用即可拿到当前组件的属性与回调：

```tsx
import { bindHandlers, bindProps, defineComponent } from '@lania-v/runtime';

export default defineComponent(function Panel(_props: PanelProps) {
  // 形参仍需保留，编译器据此推导 prop 名单；但不用再传给 bind 辅助函数。
  const p = bindProps<PanelProps>();   // 只有普通属性
  const h = bindHandlers<PanelProps>(); // 只有 onXxx 回调

  return (
    <button onClick={() => h.onToggle?.()}>
      {p.title}
    </button>
  );
});
```

注意：

- 两个 API 都不接受参数，编译产物会改写成内部工厂
  `createBoundProps(this.props)` / `createBoundHandlers(this.props)`，
  因此手动创建元素、SSR 升级与 HMR 重跑 `setup` 都能拿到实例快照；
- 未编译的函数组件走 JSX 运行时提供的当前 props 上下文；
- 在组件上下文之外调用会直接报错；
- 视图是只读的，不会复制 `props`；
- `bindHandlers()` 是**父传回调输入**，不是 `emit()`；
- handler 的识别优先使用编译期写入的 `handlerKeys`，缺失时才按 `onXxx` 推断。

## 上下文

Context 通过 DOM 事件冒泡查找最近的 provider，不依赖组件树全局状态。完整用法见
[上下文（Context）](/guide/context)。

```tsx
import {
  createContext,
  createSignal,
  defineComponent,
  provideContext,
  useContext,
} from '@lania-v/runtime';

const ThemeContext = createContext<'light' | 'dark'>('light');

const ThemeProvider = defineComponent(function ThemeProvider(props: {
  children?: unknown;
}) {
  const theme = createSignal<'light' | 'dark'>('dark');

  // 编译期改写成 provideContext(this, ThemeContext, theme)
  provideContext(ThemeContext, theme);

  return <div>{props.children as any}</div>;
});

const ThemeLabel = defineComponent(function ThemeLabel() {
  // 编译期改写成 useContext(ThemeContext, this)
  const theme = useContext(ThemeContext);

  return <p>theme: {theme()}</p>;
});
```

- `createContext(defaultValue)` 创建带默认值的 Context；
- `provideContext(Context, value)` 只能在编译组件内使用，编译期会补上 `this`；
- 组件外或手写 Custom Element 使用 `provideContext(host, Context, value)` 和
  `useContext(Context, host)`；
- `useContext()` 返回只读 Signal，没有 provider 时退回默认值。

值类型、Provider 查找规则与运行时作用域的区别见 [上下文（Context）](/guide/context)。

## 样式

### `css` 与 `Component.styles`

```ts
import { css } from '@lania-v/runtime';

const styles = css`
  :host {
    display: block;
  }

  .card {
    padding: 16px;
  }
`;

Counter.styles = styles;
```

也可以传数组：

```ts
Counter.styles = [baseStyles, themeStyles];
```

运行时优先使用 `adoptedStyleSheets`；不支持时回退到 `<style>`。

### 渲染模式

```ts
Counter.renderMode = 'light';
```

| 模式 | 说明 |
| --- | --- |
| `shadow`（默认） | 创建/复用 ShadowRoot |
| `light` | 直接渲染到宿主元素 |

### CSS 变量与主题

```ts
import {
  createCSSVariables,
  applyCSSVariables,
  provideStyleVariables,
  consumeStyleVariables,
} from '@lania-v/runtime';

const theme = createCSSVariables({
  primaryColor: '#7c3aed',
  radius: '12px',
});

applyCSSVariables(element, theme);

// 或通过 Context 跨层传递
const dispose = provideStyleVariables(element, theme);
const variables = consumeStyleVariables(child);
```

`StyleVariablesContext` 可用于跨层传递变量。

## 表单关联

默认情况下组件不参与原生表单。需要参与时显式声明：

```tsx
import { createSignal, defineComponent, useFormValue, useFormValidity } from '@lania-v/runtime';

export default defineComponent(function CredentialField() {
  const account = createSignal('');
  const valid = createSignal(false);

  useFormValue(() => account.value);

  useFormValidity(() =>
    valid.value ? true : { valid: false, message: '请输入有效值' }
  );

  return (
    <input
      value={account.value}
      onInput={(event) => account.set((event.target as HTMLInputElement).value)}
    />
  );
});
```

编译产物会生成：

- `static formAssociated = true`；
- 一个 effect Updater，依赖变化时调用 `_setFormValue()` / `_setFormValidity()`。

`setFormValue` 的归一化规则：

| 值 | 上报结果 |
| --- | --- |
| `null` / `undefined` | 不上报 |
| `string` | 原样 |
| `boolean` | `true` → `'on'`，`false` → 不上报 |
| `File` / `FormData` | 原样 |
| 其它 | `String(value)` |

`useFormValidity` 接受：

- `true` / `false`；
- `{ valid: false, message }`；
- `null` / `undefined`（视为通过）。

`useFormValue` / `useFormValidity` 只接受单表达式 getter，且是编译期 API。

## 一个文件多个组件

```tsx
const Child = defineComponent(function Child(props: { label: string }) {
  return <span>{props.label}</span>;
});

const Parent = defineComponent(function Parent() {
  return <Child label="nested" />;
});

export default Parent;
```

- 每个组件都会生成独立的类；
- `export default` 指向默认导出；
- 没有默认导出时取第一个组件；
- 其余组件按名字具名导出。

## 懒加载

```ts
import { lazy } from '@lania-v/runtime';

const LazyPanel = lazy(() => import('./LazyPanel.lania.tsx'));

await LazyPanel.preload();
```

组件未加载完成时调用会 `throw` 一个 Promise，交给上层 `Suspense` 捕获。

## 下一步

- [条件与列表](/guide/control-flow)：`When`、`Switch`、`Each`。
- [异步与边界](/guide/async-and-boundaries)：`Suspense`、`ErrorBoundary`、`LazyLoad`、`Await`。
- [组件 API](/api/component)：完整签名与类型。
