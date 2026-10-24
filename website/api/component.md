# 组件 API

这一页覆盖组件的定义、挂载、生命周期、插槽、上下文、样式、表单与事件。

先看一张生命周期与更新顺序图：

```text
定义
  defineComponent(fn, options)
    → 编译为 class extends ReactiveElement

连接
  connectedCallback()
    → __fcOnMount()
    → createRenderRoot()
    → adoptStyles()
    → _renderAndMount()

更新
  signal.set()
    → requestUpdate()
    → shouldUpdate()
    → willUpdate()
    → _flushUpdaters()
    → updated()
    → __fcOnUpdated()
    → firstUpdated()（仅首次）

断开
  disconnectedCallback()
    → __fcOnCleanup()
    → 解绑 signals / updaters
```

## 定义组件

### `defineComponent()`

```ts
defineComponent<T extends FunctionComponent<any, any>>(
  component: T,
  options?: {
    props?: PropOptionsMap;
    emits?: readonly string[];
  }
): T & ComponentElementConstructor
```

```ts
type FunctionComponent<Props = Record<string, unknown>, Result = unknown> = (
  props: Props
) => Result;
```

```tsx
export default defineComponent(
  function FancyInput(props: FancyInputProps) {
    return <div>{props.count}</div>;
  },
  {
    props: {
      count: { type: Number, reflect: true, default: 0 },
      onSelect: { attribute: false },
    },
    emits: ['select'],
  }
);
```

#### 第二个参数发生了什么

`options` **不会在运行时被解释**，而是由编译器读取并生成类静态字段：

```ts
static __laniaOptions = { props, emits };
static propOptions = resolvePropOptions(this.__laniaOptions?.props);
static emits = this.__laniaOptions?.emits;
static observedAttributes = resolveObservedAttributes(this.propOptions, this.__laniaPropNames);
```

因此：

- 选项可以是模块级常量、导入对象、展开表达式；
- 选项在模块求值时执行；
- 未编译时，第二个参数不会生效。

#### 标签名推导

`getComponentTagName()` 的解析顺序：

```text
static tagName
  → static displayName
  → class / function name
  → kebab-case
  → 没有连字符时补 x-
  → 以 xml 开头时补 x-
```

| 名称                               | 标签         |
| ---------------------------------- | ------------ |
| `Counter`                          | `x-counter`  |
| `TodoList`                         | `todo-list`  |
| `Card` + `displayName = 'my-card'` | `my-card`    |
| `XMLView`                          | `x-xml-view` |

#### 重复注册

浏览器只允许同一标签注册一次。运行时行为：

- 同名且同构造器：直接复用；
- 同名不同构造器 + dev + HMR：热替换原型；
- 同名不同构造器 + dev：一次性 warning；
- 同名不同构造器 + production：保留先注册的构造器。

### `ComponentElementConstructor`

```ts
interface ComponentElementConstructor<
  TElement extends HTMLElement = HTMLElement,
> extends CustomElementConstructor {
  new (): TElement;
  tagName?: string;
  displayName?: string;
  styles?: StaticStyles;
  handlerKeys?: readonly string[];
  propOptions?: PropOptionsMap;
  emits?: readonly string[];
}
```

| 字段          | 作用                                         |
| ------------- | -------------------------------------------- |
| `tagName`     | 显式标签名                                   |
| `displayName` | 用于推导标签名与调试                         |
| `styles`      | 静态样式，挂载时注入                         |
| `handlerKeys` | 编译期声明的 `onXxx` 名单                    |
| `propOptions` | prop 的 attribute / reflect / converter 规则 |
| `emits`       | 事件声明，开发态校验                         |

### `getComponentTagName()`

```ts
getComponentTagName(ctor: unknown): string | null
```

无法解析时返回 `null`。`createComponentElement()` 在拿不到标签名时会抛 `TypeError`。

### `isComponentElementConstructor()`

```ts
isComponentElementConstructor(value: unknown): value is ComponentElementConstructor
```

判断一个值是否是继承 `HTMLElement` 的构造器：

```ts
isComponentElementConstructor(Counter); // true
isComponentElementConstructor(() => {}); // false
```

## 挂载

### `createRoot()`

```ts
createRoot(
  container: Element | DocumentFragment | ShadowRoot
): {
  render(content: unknown): void;
  unmount(): void;
}
```

`createRoot()` 是**轻量挂载器**，不是组件树根：

```tsx
const root = createRoot(document.querySelector('#app')!);

root.render(<App />);
root.unmount();
```

#### 接受的值

| 值                             | 行为           |
| ------------------------------ | -------------- |
| `Node`                         | `appendChild`  |
| 字符串 / 数字                  | 转成文本节点   |
| 数组                           | 递归展开       |
| `null` / `undefined` / `false` | 忽略           |
| 函数                           | 抛 `TypeError` |

```tsx
root.render(<Counter />); // JSX 结果
root.render(Counter({})); // 直接调用组件
root.render('plain text');
root.render([<Counter />, <p>done</p>]);
```

#### 清理语义

- `render()` 会先清空容器；
- 清空时会对每个节点执行登记的 renderable cleanups；
- `unmount()` 等价于清空；
- 不做 diff，不会复用旧节点。

#### 为什么不能传函数引用

```tsx
root.render(Counter); // TypeError
```

`Counter` 是组件构造器，不是已渲染值。`createRoot()` 不会替你调用组件，也不会创建组件树。

### `createComponentElement()`

```ts
createComponentElement<T extends ComponentElementConstructor>(
  ctor: T,
  options?: {
    tagName?: string;
    styles?: StaticStyles;
    props?: Record<string, unknown>;
  }
): InstanceType<T>
```

流程：

1. 注册自定义元素；
2. 把编译期 handler 名单挂到 props 元数据；
3. 把 props 压入“构造期 props 栈”；
4. `document.createElement(tagName)`；
5. 通过 **property** 写入 props；
6. 返回实例。

```ts
const element = createComponentElement(Counter, {
  props: { title: 'hello', count: 1 },
});
```

通过 property 而不是 attribute 写入，意味着可以直接传对象、数组、函数。

### `mountComponent()`

```ts
mountComponent<T extends ComponentElementConstructor>(
  container: Element | DocumentFragment | ShadowRoot,
  ctor: T,
  options?: CreateComponentElementOptions
): InstanceType<T>
```

等价于：

```ts
const element = createComponentElement(ctor, options);
createRoot(container).render(element);
```

返回挂载后的元素引用，便于测试或命令式操作。

## 懒加载

### `lazy()`

```ts
lazy<T extends FunctionComponent<any, any>>(
  loader: () => Promise<T | { default: T }>
): LazyComponent<T>

interface LazyComponent<T> {
  (...args: Parameters<T>): ReturnType<T>;
  preload(): Promise<T>;
  resolved(): T | null;
}
```

```ts
const LazyPanel = lazy(() => import('./LazyPanel.lania.tsx'));
```

行为：

1. 第一次调用时如果没有 resolved 组件，就 `throw` 加载 Promise；
2. 最近的 `Suspense` 捕获 Promise，渲染 fallback；
3. Promise resolve 后重放调用；
4. 后续调用直接走同步路径。

```tsx
<Suspense fallback={<p>loading...</p>}>
  <LazyPanel />
</Suspense>
```

手动预加载：

```ts
await LazyPanel.preload();
LazyPanel.resolved(); // 组件或 null
```

`preload()` 和第一次调用共享同一个 Promise，不会重复请求。

## 函数组件辅助

### `bindProps()`

```ts
bindProps<T extends object>(): BoundProps<T>
```

返回**排除了 `onXxx` handler** 的只读视图，自动取当前组件的 props，不接受参数。

```tsx
const p = bindProps<PanelProps>();

return <h1>{p.title}</h1>;
```

特点：

- 不复制原对象；
- 属性值是 getter，始终回读原始 props；
- 视图对象只创建一次；
- 原始 `props` 仍然可用；
- 编译产物会改写成内部工厂 `createBoundProps(this.props)`，
  函数组件则由 JSX 运行时提供当前 props。

### `bindHandlers()`

```ts
bindHandlers<T extends object>(): BoundHandlers<T>
```

返回只包含 handler 的只读视图，同样不接受参数：

```tsx
const h = bindHandlers<PanelProps>();

return <button onClick={() => h.onToggle?.()}>toggle</button>;
```

handler 识别：

1. 优先使用编译期写入的 `handlerKeys`；
2. 缺失时按 `/^on[A-Z]/` + 值为函数 / `{ handler }` 推断。

::: tip bindHandlers 不是 emit

- `bindHandlers()`：父组件传下来的**输入回调**；
- `emit()`：组件向外的**事件输出**。

:::

### `bindSlots()`

```ts
bindSlots(props?: { children?: unknown }): SlotBindings

interface SlotBindings {
  has(name?: string): boolean;
  get(name?: string): unknown;
  render(name: string, fallback?: unknown, ...args: unknown[]): unknown;
  renderDefault(fallback?: unknown, ...args: unknown[]): unknown;
}
```

```tsx
const slots = bindSlots();

<header>{slots.render('header', <h2>默认标题</h2>) as any}</header>
<main>{slots.renderDefault(<p>空</p>) as any}</main>
```

#### 插槽内容来源

- 运行时 JSX：读取当前 runtime scope 的 `slotContent`；
- 编译后的 Custom Element：编译器把 `bindSlots()` 改写成
  `bindSlots(this.props)`，从 `children` prop 读取。

编译组件的普通子节点不会自动进入 `props.children`，具名槽需要显式传对象：

```tsx
<Panel
  children={{
    header: <h2>标题</h2>,
    default: <p>正文</p>,
  }}
/>
```

#### 解析顺序

- `render(name, fallback, ...args)`：
  `children[name] ?? children.default ?? fallback`；
- `renderDefault(fallback, ...args)`：`children.default ?? fallback`；
- `get(name)`：`children[name] ?? children.default`；
- `has(name)`：只检查 `children[name]`，不兜底。

因此具名槽缺失但默认槽存在时，`render('footer', 'fallback')` 返回的是默认槽内容。
完整说明见 [插槽](/guide/slots)。

#### 函数型 slot

```tsx
// 子组件
slots.renderDefault('empty', item);

// 父组件
<Child children={(item: Item) => <Row item={item} />} />;
```

额外参数会按位置传给函数型 slot。`get()` / `has()` 不会调用函数。

#### Shadow DOM 行为

当宿主有 `shadowRoot` 时，`render()` 可能返回原生 `<slot>` 元素交给浏览器投影；否则直接展开为可渲染值。
子节点上的 `slot="name"` 属于原生投影路径，不会被 `has(name)` 识别。

### `createExpose()`

```ts
type RefProp<T> = T | RefBinding<T> | null | undefined;

createExpose<T extends object>(
  props: { ref?: RefProp<T> },
  exposed: T
): T
```

```tsx
type PanelExpose = {
  focusInput(): void;
};

createExpose(props, {
  focusInput: () => {
    inputRef?.focus();
  },
});
```

行为：

- 如果 `props.ref` 存在，立即 `setRef(ref, exposed)`，并记录该暴露面；
- 在当前函数组件渲染结果上登记 cleanup；
- 组件替换内容或卸载时把 ref 置空；
- 没有 ref 时原样返回 `exposed`。

编译组件里父组件写 `<Panel ref={panelRef} />` 时，`createRef()` 声明的字段
会收到这里的 `exposed`；子组件没有调用 `createExpose()` 时退回宿主元素。

::: tip 用箭头函数声明暴露方法
编译器会把组件内的本地引用改写成 `this.xxx`，普通对象方法的 `this` 不是组件实例。
`createExpose()` 的回调请写成箭头函数属性（`focusInput: () => {}`）。
:::

父组件：

```tsx
const panelRef = createRef<PanelExpose>();

<Panel ref={panelRef} />;

panelRef?.focusInput();
```

## 生命周期

### 函数组件 hooks

```ts
onMount(callback: () => void): void
onMounted(callback: () => void): void // 别名

onCleanup(callback: () => void): void
onUnmounted(callback: () => void): void // 别名

onUpdated(callback: (changedProps: ChangedProps) => void): void
```

```tsx
export default defineComponent(function Panel() {
  let timer: ReturnType<typeof setInterval> | undefined;

  onMount(() => {
    timer = setInterval(tick, 1000);
  });

  onCleanup(() => {
    if (timer) clearInterval(timer);
  });

  onUpdated((changedProps) => {
    console.log([...changedProps.keys()]);
  });

  return <div />;
});
```

::: warning compile-only
这些函数在公共运行时中直接调用会抛错。它们必须出现在 `.lania.tsx` 的编译链中。
:::

### `ChangedProps`

```ts
type ChangedProps = Map<string, { previous: unknown; current: unknown }>;
```

同一轮内多次写入同一个 key：

- `previous` 保留第一次的值；
- `current` 以最后一次为准。

### 类生命周期

手写 `ReactiveElement` 时可以覆写：

| 方法                                        | 时机                      |
| ------------------------------------------- | ------------------------- |
| `connectedCallback()`                       | 连接到 DOM                |
| `disconnectedCallback()`                    | 从 DOM 断开               |
| `attributeChangedCallback(name, old, next)` | observed attribute 变化   |
| `adoptedCallback()`                         | 文档迁移                  |
| `errorCallback(error)`                      | 错误回调                  |
| `shouldUpdate(changedProps)`                | 更新前，返回 `false` 跳过 |
| `willUpdate(changedProps)`                  | 更新前                    |
| `updated(changedProps)`                     | 更新后                    |
| `firstUpdated(changedProps)`                | 首次更新后                |

```ts
class MyElement extends ReactiveElement {
  protected shouldUpdate(changedProps: ChangedProps): boolean {
    return changedProps.has('visible');
  }
}
```

注意：`shouldUpdate()` 返回 `false` 时：

- 不执行 `willUpdate` / `updated` / `firstUpdated`；
- 不执行 updater flush；
- 下一次 `requestUpdate()` 仍会再次尝试。

## `ReactiveElement`

```ts
abstract class ReactiveElement extends HTMLElement {
  static renderMode: 'shadow' | 'light';
  static hydration: 'eager' | 'manual';
  static styles?: StaticStyles;
  static formAssociated: boolean;
  static propOptions?: PropOptionsMap;
  static emits?: readonly string[];
  static observedAttributes?: readonly string[];

  protected renderRoot!: ShadowRoot | this;

  hydrate(): void;
  get isHydrated(): boolean;

  emit<T>(
    name: string,
    detail?: T,
    options?: Omit<CustomEventInit<T>, 'detail'>
  ): boolean;

  requestUpdate(name?: string, previous?: unknown, current?: unknown): void;
  performUpdate(): void;
}
```

### 渲染根

```ts
static renderMode = 'shadow'; // 默认
static renderMode = 'light';
```

- `shadow`：创建 / 复用 `ShadowRoot`；
- `light`：直接渲染到宿主元素；
- SSR 输出 `<template shadowrootmode>` 时优先接管已有 shadow root。

### 水合策略

```ts
static hydration = 'eager';  // 默认
static hydration = 'manual'; // 等 hydrate()
```

`manual` 组件连接后：

- 绑定 signals；
- 创建 render root；
- 注入样式；
- 但不执行 `_renderAndMount()`。

调用 `hydrate()` 后才挂载。

### `trackSignal()`

```ts
protected trackSignal<T>(signal: Signal<T>): void
```

把 Signal 注册为**组件级依赖**：

- 连接时把 `requestUpdate` 挂到 `signal.updaters`；
- 断开时移除；
- 任一 Signal 变化都会触发组件更新。

用于手写组件：

```ts
class Counter extends ReactiveElement {
  count = createSignal(0);

  constructor() {
    super();
    this.trackSignal(this.count);
  }
}
```

编译组件通常不需要手动调用：运行时会在连接后自动发现实例上的 Signal 字段。

### `registerUpdater()`

```ts
protected registerUpdater(updater: () => void): void
```

注册一个**纯函数 updater**：

- 每次 `_flushUpdaters()` 都执行；
- 不参与依赖订阅；
- 适合“组件刷新时重新算一遍”的逻辑。

### `registerRuntimeUpdater()`

```ts
protected registerRuntimeUpdater(updater: Updater): void
```

注册一个**运行时 Updater**：

- 连接时 `attach()`；
- 断开时 `detach()`；
- 只有 `dirty` 或对应 Slot 脏时才执行；
- `kind === 'effect'` 的 Updater 首次会标记 dirty。

### `registerSlot()`

```ts
protected registerSlot<TSlot extends Slot>(slot: TSlot): TSlot
```

把 Slot 加入 `SlotTable`：

- 建立 `slotIndex → slot` 映射；
- 支持脏位跟踪；
- 卸载时统一 `destroyAll()`。

### `requestUpdate()`

```ts
requestUpdate(name?: string, previous?: unknown, current?: unknown): void
```

- 同一微任务内多次调用合并为一次；
- 可附带 changed prop 记录；
- 通过 `scheduleLifecycle(..., 'high')` 排队。

```ts
this.requestUpdate('count', previous, next);
```

### `performUpdate()`

执行一次完整更新：

```text
changedProps 快照
  → shouldUpdate
  → willUpdate
  → _flushUpdaters
  → updated
  → __fcOnUpdated
  → firstUpdated
```

手动调用它通常只用于测试。

## 派发事件

### `emit()`

```ts
emit<T>(
  name: string,
  detail?: T,
  options?: Omit<CustomEventInit<T>, 'detail'>
): boolean
```

```ts
class MyPicker extends ReactiveElement {
  select(id: string) {
    this.emit('select', { id });
  }
}
```

默认值：

```ts
{
  bubbles: true,
  composed: true,
  cancelable: false,
}
```

- `composed: true` 让事件可以穿过 Shadow DOM；
- 返回 `dispatchEvent()` 的结果；
- `emits` 声明只做开发态校验，不阻止派发。

## 表单

### `useFormValue()`

```ts
useFormValue(getter: () => unknown): void // compile-only
```

```tsx
const account = createSignal('');
useFormValue(() => account());
```

编译产物：

```ts
static formAssociated = true;
// effect updater
this._setFormValue(this.account());
```

值归一化：

| 值                   | 上报                              |
| -------------------- | --------------------------------- |
| `null` / `undefined` | 不上报                            |
| `string`             | 原样                              |
| `boolean`            | `true` → `'on'`，`false` → 不上报 |
| `File` / `FormData`  | 原样                              |
| 其它                 | `String(value)`                   |

### `useFormValidity()`

```ts
useFormValidity(
  getter: () => boolean | { valid: boolean; message?: string } | null | undefined
): void // compile-only
```

```tsx
useFormValidity(() =>
  valid() ? true : { valid: false, message: '请输入有效值' }
);
```

映射：

```ts
// 通过
internals.setValidity({});

// 失败
internals.setValidity({ customError: true }, message);
```

### `ReactiveElement` 内部方法

```ts
protected _setFormValue(value: unknown): void
protected _setFormValidity(result: unknown): void
```

只在 `formAssociated = true` 且平台支持 `ElementInternals` 时生效。

## Prop 选项

### `PropOption`

```ts
interface PropOption {
  type?:
    | StringConstructor
    | NumberConstructor
    | BooleanConstructor
    | ObjectConstructor
    | ArrayConstructor;
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

#### `type`

决定 attribute 字符串如何回读：

| 类型               | 行为                                  |
| ------------------ | ------------------------------------- |
| `String`           | 原样                                  |
| `Number`           | `Number(value)`                       |
| `Boolean`          | `value !== null && value !== 'false'` |
| `Object` / `Array` | `JSON.parse(value)`，解析失败会抛错   |

更复杂的结构请用 `converter`。

#### `attribute`

- 字符串：自定义 attribute 名；
- `false`：不参与 attribute 同步；
- 未设置：按 kebab-case 推导。

```ts
userName → user-name
maxCount → max-count
```

#### `reflect`

prop 变化时写回 attribute：

```ts
count: { type: Number, reflect: true }
```

#### `converter`

```ts
level: {
  type: Number,
  converter: {
    from: (value) => (value === null ? 0 : Number(value) * 10),
    to: (value) => String(Number(value) / 10),
  },
}
```

#### `validator`

开发态校验，失败输出 warning；不会阻止写入。

### 运行时辅助

```ts
resolvePropOptions(input)
resolveObservedAttributes(propOptions, propNames)
resolvePropAttributeName(name, option)
resolvePropInitialValue(component, name, fallback)
normalizePropOption(option)
reflectInitialProps(component)
parsePropAttributeValue(...)
serializePropAttributeValue(...)
reflectPropAttribute(...)
applyPropAttributes(...)
validatePropValue(...)
```

这些函数由编译产物调用；手写 `ReactiveElement` 时也可以复用。

## 事件系统

### 模板/JSX 写法

```tsx
// DOM 事件
<button onClick={submit} />
<button onClick={{ handler: submit, modifiers: { stop: true, prevent: true } }} />

// 组件事件（子组件 emit）
<child-card onToggle={handleToggle} />
<child-card onToggle={{ handler: handleToggle, listener: { once: true } }} />
```

`onXxx` 在原生标签上映射为小写 DOM 事件（`onKeyDown` → `keydown`），在组件标签上映射为组件事件（`onToggle` → `toggle`）。

### 解析事件名

```ts
parseEventBindingName(sourceName: string): ParsedEventBindingName | null
```

支持的形态：

| 写法        | 结果                          |
| ----------- | ----------------------------- |
| `onClick`   | DOM `click`                   |
| `onKeyDown` | DOM `keydown`（事件名转小写） |
| `onToggle`  | 组件事件 `toggle`             |

### 修饰符

```ts
type EventModifier =
  | 'stop'
  | 'prevent'
  | 'self'
  | 'enter'
  | 'passive'
  | 'immediate'
  | 'left'
  | 'middle'
  | 'right'
  | 'prevent:self'
  | 'prevent:immediate'
  | `key:${string}`
  | `system:${'ctrl' | 'shift' | 'alt' | 'meta'}`
  | `button:${'left' | 'middle' | 'right'}`
  | (string & {});
```

| 修饰符                                           | 行为                                                           |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `stop`                                           | `event.stopPropagation()`                                      |
| `prevent`                                        | `event.preventDefault()`                                       |
| `prevent:self`                                   | `event.target === event.currentTarget` 时才 `preventDefault()` |
| `prevent:immediate`                              | `preventDefault()` + `stopImmediatePropagation()`              |
| `self`                                           | `event.target === event.currentTarget` 时才继续                |
| `immediate`                                      | `event.stopImmediatePropagation()`                             |
| `enter`                                          | 键盘 `Enter` 时才继续（仅键盘事件）                            |
| `passive`                                        | 提示性标记，真正生效需走 `listener`                            |
| `button:left` / `button:middle` / `button:right` | 鼠标键匹配时才继续                                             |
| `key:<name>`                                     | `event.key` 匹配时才继续（仅键盘事件）                         |
| `system:ctrl` / `shift` / `alt` / `meta`         | 对应系统键按下时才继续                                         |

规则：

- `enter` / `key:*` / `system:*` 只允许出现在 `keydown` / `keyup` / `keypress` 上，否则编译报错；
- 键盘事件上的普通词会被规范化为 `key:<词>`（`keydown.escape` → `key:escape`），
  但 `once` / `immediate` / `passive` / `left` / `middle` / `right` 等保留词保持原义；
- 执行顺序：先做 `key:*` / `system:*` / `button:*` / `self` 过滤，
  再执行 `stop` / `prevent` / `prevent:self` / `prevent:immediate` / `immediate`，最后调用用户 handler；
- 任一过滤失败即短路；
- `once` / `capture` / `passive` 属于原生监听选项，写在 `listener` 里（后缀 `onClick.once` 会被降级为 listener 选项）；
- 组件事件只接受 `listener`，写了 `modifiers` 会编译报错。

### `withEventModifiers()`

```ts
withEventModifiers(handler, modifiers);
```

```ts
const handler = withEventModifiers(submit, ['stop', 'prevent']);
```

### `withEventHint()`

`debounce` / `throttle` 这类提示性修饰符需要额外监听，运行时通过 `withEventHint()` 包装：

```ts
withEventHint(handler, 'debounce', modifiers?, { debounceMs?: number, throttleMs?: number })
```

```ts
const search = withEventHint(runSearch, 'debounce', [], { debounceMs: 200 });
```

编译期遇到 `onInput.debounce` 或 `handler: withEventHint(fn, 'debounce')` 会拆成“处理器 + 提示”，
不会产生双层包装。

### 事件委托

```ts
enableEventDelegation(root);
disableEventDelegation(root);
```

条件：

- 事件名在白名单中；
- 没有显式传 `options`；
- 节点位于已启用委托的 root 内。

白名单：

```ts
click input change keydown keyup keypress submit focus blur pointerdown pointerup
```

委托实现：

- 同一 root + 事件名只挂一条原生监听；
- 通过 `composedPath()` 按传播路径分发；
- `event.cancelBubble` 为真时停止。

## 运行时作用域（高级）

::: tip 不是 Context API
这一节的运行时作用域用于框架内部桥接，不是 `createContext()` / `useContext()` 的 Context。
业务侧跨层传值请见 [上下文（Context）](/guide/context)。
:::

```ts
withRuntimeScope<T>(scope: RuntimeScope, run: () => T): T
withContextHost<T>(host: RuntimeScopeHost, run: () => T): T
withDomHost<T>(target: DomHostTarget, run: () => T): T

interface RuntimeScope {
  host?: RuntimeScopeHost;
  domHost?: DomHostTarget;
  slotContent?: unknown;
  functionComponentCleanups?: Set<() => void>;
}
```

这些 API 用于：

- 在动态 slot 中建立 host 上下文；
- 让增强组件读取当前宿主；
- 支持 TransitionGroup 等结构重定向。

业务代码通常不需要直接使用。

## 编译期辅助（运行时导出）

```ts
getComponentCreationProps(): Record<string, unknown> | null
createComponentPropsSnapshot(instance: object, propNames: readonly string[]): Record<string, unknown>
attachFunctionComponentBindingMetadata<T extends object>(props: T, metadata?): T
registerFunctionComponentRenderResult(result: unknown, cleanups: Set<() => void>): void
runRenderableCleanups(value: unknown, fired?: Set<() => void>): void
```

| API                                        | 用途                              |
| ------------------------------------------ | --------------------------------- |
| `getComponentCreationProps()`              | 构造期读取待写入 props            |
| `createComponentPropsSnapshot()`           | 为实例创建带 getter 的 props 快照 |
| `attachFunctionComponentBindingMetadata()` | 标记 handler key                  |
| `registerFunctionComponentRenderResult()`  | 把 cleanup 绑定到渲染节点         |
| `runRenderableCleanups()`                  | 卸载时执行 cleanup                |

这些函数由编译产物调用，业务代码通常不需要直接使用。
