# 上下文（Context）

Context 用于跨多层组件传值，例如主题、locale、表单配置或路由信息。它不依赖组件树全局变量，
而是沿着 DOM 事件冒泡寻找最近的 provider。

## 设计模型

```text
consumer dispatch 'lania:context-request'
  → 最近的 provider 拦截
  → resolve 对应的 ReadonlySignal
  → 没有 provider 时使用 defaultValue
```

- Custom Element 与函数组件共用同一套机制；
- 事件使用 `composed: true`，可以跨 Shadow DOM 边界；
- provider 拦截后调用 `stopPropagation()`，因此**最近的 provider 生效**；
- 没有全局单例，同一个 Context 可以在不同子树里提供不同的值。

## 快速开始

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

父组件直接包住 consumer：

```tsx
<ThemeProvider>
  <ThemeLabel />
</ThemeProvider>
```

Context 只要求 consumer 在 provider 宿主的 DOM 子树中；children 的显示方式由插槽 / 投影决定，
见 [插槽](/guide/slots)。

`useContext()` 返回只读 Signal，读取 `theme()` 才建立响应式依赖。

## API

### `createContext()`

```ts
createContext<T>(defaultValue: T, description?: string): Context<T>

interface Context<T> {
  readonly id: symbol;
  readonly defaultValue: ReadonlySignal<T>;
  readonly description?: string;
}
```

```ts
const ThemeContext = createContext<'light' | 'dark'>('light');
```

`defaultValue` 会被包装成只读 Signal，因此 consumer 始终拿到统一的 Signal 语义。

### `provideContext()`

```ts
// 运行时：显式指定宿主
provideContext<T>(
  host: EventTarget,
  context: Context<T>,
  value: T | ReadonlySignal<T> | (() => T)
): () => void;

// 编译组件内：编译器补 this
provideContext<T>(
  context: Context<T>,
  value: T | ReadonlySignal<T> | (() => T)
): () => void;
```

```ts
const dispose = provideContext(element, ThemeContext, themeSignal);
dispose();
```

- 在 `host` 上监听 `lania:context-request`；
- 匹配 `context.id` 时 `stopPropagation()` 并解析值；
- 返回取消提供的函数。

### `useContext()`

```ts
useContext<T>(
  context: Context<T>,
  host?: { dispatchEvent(event: Event): boolean }
): ReadonlySignal<T>
```

```tsx
// 编译组件内：自动使用当前组件宿主
const theme = useContext(ThemeContext);

// 组件外 / 手写 Custom Element：显式指定宿主
const theme = useContext(ThemeContext, element);
```

没有宿主时退回 `context.defaultValue`。

## 值类型

| 传入          | 行为                              |
| ------------- | --------------------------------- |
| Signal / Memo | 直接使用，consumer 会随值更新     |
| `() => T`     | 初始化时求值一次，再包装为 Signal |
| 普通值        | 包装为 Signal                     |

::: warning 函数不等于响应式
`provideContext(Context, () => value)` 只会在初始化时调用一次。需要后续更新时请传 Signal
或 Memo，而不是普通函数。
:::

## 编译期改写

在 `.lania.tsx` 编译组件内，下面的简写会被编译器补上宿主：

```tsx
provideContext(ThemeContext, theme);
// →
provideContext(this, ThemeContext, theme);

const theme = useContext(ThemeContext);
// →
const theme = useContext(ThemeContext, this);
```

因此：

- 两参 `provideContext()` 只能在编译组件内使用；
- 运行时直接调用两参形式会抛错，请改用 `provideContext(host, context, value)`；
- 编译器改写见 [编译期 API · 上下文标记](/api/compile-time#上下文标记)。

## Provider 的查找规则

Context 依赖 DOM 事件路径，不是逻辑上的组件树：

- provider 必须位于 consumer 宿主的 DOM 祖先链上；
- 最近的 provider 生效，更上层的 provider 不会再收到请求；
- consumer 位于未连接 DOM 的子树时，事件不会冒泡到 provider，会拿到默认值；
- provider 卸载后，监听器随宿主一起移除；需要提前取消时调用返回的 `dispose()`。

```tsx
<ThemeProvider>
  <section>
    <ThemeLabel />
  </section>
</ThemeProvider>
```

只要 `ThemeProvider` 的宿主是 `ThemeLabel` 宿主的祖先，中间隔多少层都可以。

## 与运行时作用域的区别

`lania-v` 里还有一组内部运行时作用域 API：

```ts
withRuntimeScope(scope, run);
withContextHost(host, run);
withDomHost(target, run);
```

它们用于让增强组件、动态 slot 读取当前 `host` / `domHost` / `slotContent`，
不是业务侧的 Context API。二者区别：

- 入口：Context API 使用 `createContext` / `provideContext` / `useContext`；
  运行时作用域使用 `withRuntimeScope` / `withContextHost`。
- 用途：前者是跨层业务状态，后者是运行时内部桥接。
- 查找方式：前者依赖 DOM 事件冒泡，后者依赖同步调用栈。
- 业务代码：前者直接使用，后者通常不需要。

`withContextHost()` 只是让 `useContext()` 在函数组件里找到当前宿主，不会创建或提供 Context。

## 常见问题

### `useContext()` 总是返回默认值？

- provider 不在 consumer 宿主的 DOM 祖先路径上；
- consumer 还在未连接的子树中；
- provider 的 Context 与 consumer 用的不是同一个 `createContext()` 实例。

### 值更新了，consumer 没刷新？

`provideContext()` 传入的是普通函数 `() => T` 时只会求值一次。请传入 Signal / Memo，
或直接传普通值并在需要时重新 provide。

### 能在组件外使用吗？

可以，但要用三参形式并显式传入宿主：

```ts
const dispose = provideContext(element, ThemeContext, themeSignal);
const theme = useContext(ThemeContext, element);
dispose();
```

## 下一步

- [组件](/guide/components)
- [响应式基础](/guide/reactivity)
- [响应式 API · Context](/api/reactivity#context)
