# 运行时 API 与 FC / TSX 约定

本文档同时承担两件事：

- 说明 `@lania-v/runtime` 当前已经落地并可直接使用的 API。
- 说明 `FC / TSX` 的正式主路径写法，避免语法规则散落在多份文档中。

## 1. 核心响应式 API

### `createSignal()`

```ts
const count = createSignal(0);

count();
count.set(1);
count.update((value) => value + 1);
```

### `createMemo()`

```ts
const count = createSignal(1);
const doubled = createMemo(() => count() * 2);
```

在 `FC / .lania.tsx` 里，`createMemo` 声明的计算属性会被编译成组件实例上的**可读句柄字段**：

```ts
const account = createSignal('');
const accountMissing = createMemo(() => account().trim().length === 0);

onMount(() => {
  // 裸引用拿到的是句柄本身，和 signal 一样是可调用对象
  console.log(accountMissing);
  // 取值统一写成调用形式
  console.log(accountMissing());
});
```

对应的实例字段形如 `protected accountMissing = createComputedAccessor(() => ...)`：

- `this.accountMissing()` 读取派生值，`this.accountMissing.peek()` 跳过调用直接取值。
- `this.accountMissing` 不调用时得到的是句柄，而不是布尔值，便于把计算属性当参数传递。
- 句柄不缓存，每次读取都重新求值；模板 updater 的订阅依赖由编译期静态注入，不依赖运行时调度。

### `createEffect()`

```ts
const count = createSignal(0);
const stop = createEffect(() => {
  console.log(count());
});

stop();
```

### `readonly()`

```ts
const count = createSignal(1);
const publicCount = readonly(count);
```

### `createDeferred()`

创建一个带调度语义的延迟读取值，适合需要平滑刷新节奏的场景。

### `tick()`

等待当前运行时调度器里已经入队的更新完成，适合在 imperative 场景下读取稳定后的 DOM。

```ts
const count = createSignal(0);

count.set(1);
await tick();
```

说明：

- `tick()` 等待当前 scheduler 中的 signal / lifecycle / effect flush 完成。
- 它不承诺等待 transition、动画、`setTimeout` 或其他外部异步任务。

## 2. 函数组件与挂载 API

### `defineComponent()`

```ts
const Counter = defineComponent((props: { title: string }) => {
  return <h1>{props.title}</h1>;
});
```

也支持命名函数形式：

```ts
export default defineComponent(function Counter(props: { title: string }) {
  return <h1>{props.title}</h1>;
});
```

### 生命周期 hooks

`FC` 当前正式只保留 3 个 hooks：

- `onMount`
- `onCleanup`
- `onUpdated`

兼容别名仅保留：

- `onMounted` -> `onMount`
- `onUnmounted` -> `onCleanup`

说明：

- 这些 hooks 都是 compile-only marker。
- 它们的正确前提是源码进入 `FC / .lania.tsx` 编译链并被改写。
- 如果直接在公共 runtime 调用，会抛出 compile-only 错误，而不是静默 no-op。

### `createRoot()`

`createRoot()` 是轻量挂载器，只接收“已经可渲染”的值：

```ts
const root = createRoot(container);
root.render(<App />);
root.unmount();
```

说明：

- 适合测试、demo 和直接挂载 JSX 结果。
- 不做 diff，也不会执行函数引用。
- 可以传 `<App />`、`App(props)` 的结果、`Node`、字符串、数组。
- 直接传 `App` 这类函数引用会抛错。

### `lazy()`

```ts
const LazyPanel = lazy(() => import('./LazyPanel'));
await LazyPanel.preload();
```

## 3. Context / Ref / 状态容器

### `createContext()` / `useContext()`

```ts
const ColorSchemeContext = createContext('light');

const Label = defineComponent(() => {
  return useContext(ColorSchemeContext);
});
```

### `provideContext()` / `provideContextHere()` / `consumeContext()`

- `provideContext(host, context, value)`：真实运行时 API。
- `provideContextHere(context, value)`：仅供编译期改写使用，直接调用会抛错。
- `consumeContext(host, context)`：在宿主树上消费上下文。

### `createRef()`

```ts
const buttonRef = createRef<HTMLButtonElement>();
```

### `bindProps()` / `bindHandlers()` / `bindSlots()` / `createExpose()`

这 4 个 API 面向 `FC / TSX` 主路径，提供函数组件内部更清晰的访问面：

- `bindProps(props)`：得到普通属性视图
- `bindHandlers(props)`：得到父组件传下来的回调型输入视图
- `bindSlots()`：读取默认槽和具名槽
- `createExpose(props, exposed)`：显式定义函数组件暴露给父组件 ref 的公开面

示例：

```tsx
type PanelExpose = {
  focusInput(): void;
  clearInput(): void;
};

type PanelProps = {
  title: string;
  collapsed?: boolean;
  onToggle?: () => void;
  onSubmit?: (id: string) => void;
  ref?: RefBinding<PanelExpose>;
};

const Panel = defineComponent((props: PanelProps) => {
  const p = bindProps(props);
  const h = bindHandlers(props);
  const slots = bindSlots();
  const inputRef = createRef<HTMLInputElement>();

  createExpose(props, {
    focusInput() {
      inputRef.current?.focus();
    },
    clearInput() {
      if (inputRef.current) {
        inputRef.current.value = '';
      }
    },
  });

  return (
    <section>
      <header>{slots.render('header', <h3>{p.title}</h3>)}</header>
      <input ref={inputRef} value={p.title} />
      <main>{slots.renderDefault(<p>empty</p>)}</main>
      <button onClick={() => h.onToggle?.()}>toggle</button>
      <button onClick={() => h.onSubmit?.('42')}>submit</button>
    </section>
  );
});
```

说明：

- `bindProps()` 和 `bindHandlers()` 不替代原始 `props`，只是补一个分流后的访问视图。
- `bindHandlers()` 和 `emit()` 不是一回事：前者是父传回调输入，后者是组件对外事件输出。
- `bindSlots()` 当前首期覆盖默认槽、具名槽和 fallback，不把 scoped slot 作为既有能力。
- `createExpose()` 建立在现有 `ref` / `createRef()` 之上，不引入新的组件实例系统。
- `createExpose()` 暴露的是公开面，不等同于组件内部全部状态。

### `createResource()` / `createStore()`

- `createResource()`：管理异步资源状态。
- `createStore()`：管理对象型状态容器。

## 4. JSX 返回值语义

运行时 JSX 返回的是 `LaniaJsxElement`，它表示“可被运行时直接消费的值”，而不是专门的虚拟节点对象。

它覆盖的核心语义包括：

- `Node`
- 字符串、数字、布尔值
- `null` / `undefined`
- 返回可渲染值的函数
- 这些值的数组

因此当编辑器里显示 `(): LaniaJsxElement` 时，可以直接把它理解成“这个组件返回一段运行时可渲染的结果”。

## 5. FC / TSX 正式主路径

### 5.1 事件

DOM 事件和组件事件统一使用 `onXxx`：

```tsx
<button onClick={submit} />
<child-card onToggle={handleToggle} />
<button onClick={{ handler: submit, modifiers: { stop: true } }} />
```

规则：

- 事件修饰符在 `FC` 中推荐使用对象型事件绑定。
- `click={...}`、`click.stop={...}`、`on:*` 不再属于 `FC` 标准 TSX 主路径。

### 5.2 DOM 属性与双向绑定

单向 DOM 属性写入直接使用标准 JSX props：

```tsx
<input value={draft()} />
<input checked={checked()} />
<input model={{ target: draft, modifiers: { trim: true } }} />
```

规则：

- `value={...}` / `checked={...}` 是正式单向写入主路径。
- 双向绑定主路径使用 `model={{ target, modifiers }}`。
- `bind:*`、`model:*` 不再属于 `FC` 标准 TSX 主路径。

### 5.3 `use`

```tsx
<div use={{ tooltip: options }} />
```

规则：

- 正式主路径是 `use={{ name: value }}`。
- 已注册指令是主路径，inline directive definition 仅保留兼容。
- `use` / `model` / 对象型事件绑定当前只支持对象字面量、静态 key、无 spread、无计算属性名。

### 5.4 类名与样式

```tsx
<section class="card" className={['panel', { active: visible() }]} />
<section style="color: red;" style={['color: blue;', { width: `${width()}px` }]} />
```

规则：

- `className={...}` 支持字符串、对象、数组，并会和静态 `class` 合并。
- `style={...}` 支持字符串、对象、数组，并会和静态 `style` 合并。
- `class` 仍可作为兼容属性使用，但 `FC` 主路径推荐 `className`。
- `class:*` / `style:*` 不再属于 `FC` 标准 TSX 主路径。

### 5.5 原始 HTML

```tsx
<div html={html`<strong>ready</strong>`} />
```

规则：

- `html={...}` 用于原始 HTML 写入。
- 它不能和同一元素上的静态或动态子节点同时出现。
- 默认不承担运行时消毒职责。

### 5.6 条件、列表与增强组件

当前推荐直接使用增强组件表达结构语义：

```tsx
<When when={visible()} fallback={<p>Hidden</p>}>
  <p>Visible</p>
</When>

<Each items={items()} fallback={<p>Empty</p>}>
  {(item) => <li>{item}</li>}
</Each>
```

常见增强组件包括：

- `When`
- `Each`
- `Dynamic`
- `Teleport`
- `KeepAlive`
- `Transition` / `TransitionGroup`
- `LazyLoad`
- `ErrorBoundary`
- `Suspense`

详细能力与约束请看 `enhanced-components.md`，阶段收敛目标见 `stages.md`。

### 5.7 表单关联

默认情况下组件是普通自定义元素，不参与原生表单提交。需要参与时显式声明：

```tsx
import { createSignal, defineComponent, useFormValue } from '@lania-v/runtime';

export default defineComponent(function CredentialField() {
  const account = createSignal('');

  // 组件对外暴露的表单值
  useFormValue(() => account());

  return <input value={account()} onInput={(event) => account.set(event.target.value)} />;
});
```

编译产物会额外生成：

- `static formAssociated = true`，让浏览器在 upgrade 时把组件纳入表单；
- 一个 effect updater，在 `account` 变化时调用 `_setFormValue(...)`。

因此组件会出现在 `form.elements` 中，`new FormData(form)` 也会带上当前值（键名取宿主元素的 `name` 属性）。`null` / `undefined` 会被视为“不上报”；布尔值上报为 `'on'` / 不上报。

注意：

- `useFormValue` 只能接受单表达式 getter（`() => expr` 或 `() => { return expr; }`）。
- 它是编译期 API，未收录进编译产物；在未编译的运行时里直接调用会抛错。

## 6. 当前边界

当前可以明确的结论：

- `FC / TSX` 主路径已经收口，可作为正式文档入口使用。
- `.lania.tsx` 编译失败会带源码定位信息，并透传到 Vite overlay。
- `.lania.tsx` 的模块输出只保留「业务 import + 组件类」：模块作用域里的运行时常量与函数不会进入产物。
  需要复用的辅助逻辑请放到兄弟 `.ts` 模块再 import（参考 `playground/todo/src/todo-shared.ts`、
  `playground/login/src/login-storage.ts`）。
- 复杂增强组件组合、SSR / Hydration 和兼容层行为，优先以测试与 playground 为准。
