# SSR API

`lania-v` 的 SSR 不是“把 VNode 序列化成字符串”，而是复用编译产物里的 `static render()`：

```text
编译产物
  ├── static render(props)
  ├── static renderStream(props)
  └── _renderAndMount()

SSR
  → 调用 static render()
  → 输出带 marker 的 HTML / DSD

客户端
  → 注册同一个组件类
  → hydrate / hydrateIslands
```

## 基础渲染

### `renderToString()`

```ts
interface SSRComponentLike {
  render?: (props?: Record<string, unknown>) => string;
  renderStream?: (props?: Record<string, unknown>) => AsyncGenerator<string, void, void>;
}

renderToString(
  component: SSRComponentLike,
  props?: Record<string, unknown>
): string
```

```ts
import { renderToString } from '@lania-v/runtime';
import App from './App.lania.tsx';

const html = renderToString(App, { title: 'hello' });
```

行为：

- 如果组件没有 `static render()`，抛 `TypeError`；
- 把 `props` 直接传给 `render()`；
- 返回完整 HTML 字符串；
- 不等待异步内容。

### `renderToStream()`

```ts
renderToStream(
  component: SSRComponentLike,
  props?: Record<string, unknown>
): AsyncGenerator<string, void, void>
```

```ts
for await (const chunk of renderToStream(App, { title: 'hello' })) {
  response.write(chunk);
}
```

要求组件存在 `static renderStream()`。

## Declarative Shadow DOM

### 为什么用 DSD

自定义元素的内部结构通常在客户端创建。DSD 让服务端直接输出：

```html
<x-app>
  <template shadowrootmode="open">
    <style>...</style>
    <p>hello</p>
  </template>
</x-app>
```

浏览器解析时就会创建 shadow root，首屏无需等待 JS。

### `renderDeclarativeShadowRoot()`

```ts
interface DeclarativeShadowRootOptions {
  mode?: 'open' | 'closed';
  styles?: StaticStyles;
  delegatesFocus?: boolean;
}

renderDeclarativeShadowRoot(
  html: string,
  options?: DeclarativeShadowRootOptions
): string
```

输出：

```html
<template shadowrootmode="open">
  <style data-lania-ssr-style>...</style>
  ...html
</template>
```

选项：

| 选项 | 说明 |
| --- | --- |
| `mode` | `open` / `closed` |
| `styles` | 内联进 shadow root 的静态样式 |
| `delegatesFocus` | 输出 `shadowrootdelegatesfocus` |

### `renderDeclarativeShadowComponent()`

```ts
interface DeclarativeShadowComponentOptions extends DeclarativeShadowRootOptions {
  tagName: string;
  attributes?: Record<string, unknown> | string;
  lightDom?: string;
  renderMode?: 'shadow' | 'light';
  inlineStyles?: boolean;
}

renderDeclarativeShadowComponent(
  html: string,
  options: DeclarativeShadowComponentOptions
): string
```

输出完整宿主：

```html
<x-app>
  <template shadowrootmode="open">...</template>
  <!-- lightDom -->
</x-app>
```

`attributes` 可以是字符串或对象：

```ts
renderDeclarativeShadowComponent(html, {
  tagName: 'x-app',
  attributes: { id: 'app', 'data-theme': 'dark' },
  lightDom: '<p slot="footer">footer</p>',
});
```

### `renderLightComponent()`

```ts
renderLightComponent(
  html: string,
  options: DeclarativeShadowComponentOptions
): string
```

用于 `renderMode = 'light'`：

```html
<x-app>
  <style>...</style>
  ...html
</x-app>
```

- 默认内联样式；
- `inlineStyles: false` 可关闭；
- 不创建 shadow root。

### `renderComponentToString()`

```ts
interface DeclarativeShadowComponentLike {
  render?: (props?: Record<string, unknown>) => string;
  renderStream?: (props?: Record<string, unknown>) => AsyncGenerator<string, void, void>;
  styles?: StaticStyles;
  renderMode?: 'shadow' | 'light';
}

renderComponentToString(
  component: DeclarativeShadowComponentLike,
  props: Record<string, unknown>,
  options: DeclarativeShadowComponentOptions
): string
```

行为：

1. 调用 `component.render(props)`；
2. 读取 `options.renderMode ?? component.renderMode ?? 'shadow'`；
3. `shadow` → DSD；
4. `light` → 普通 HTML；
5. `styles` 默认为 `component.styles`。

### `renderToStringWithDeclarativeShadow()`

```ts
renderToStringWithDeclarativeShadow(
  component: DeclarativeShadowComponentLike,
  props: Record<string, unknown>,
  options: DeclarativeShadowComponentOptions
): string
```

`renderComponentToString()` 的别名。

### 流式 DSD

```ts
renderStreamToDeclarativeShadow(
  component: DeclarativeShadowComponentLike,
  props: Record<string, unknown>,
  options: DeclarativeShadowComponentOptions
): AsyncGenerator<string, void, void>

renderComponentToStream(
  component: DeclarativeShadowComponentLike,
  props: Record<string, unknown>,
  options: DeclarativeShadowComponentOptions
): AsyncGenerator<string, void, void>
```

流式输出顺序：

```text
1. <x-app><template shadowrootmode="open"><style>...
2. 组件 renderStream() 产生的 chunk
3. </template></x-app>
```

首块就包含样式，避免流式传输时“先看到无样式内容”。

### 客户端接管

```ts
readDeclarativeShadowTemplate(element: Element): HTMLTemplateElement | null

attachDeclarativeShadowRoot(
  element: HTMLElement,
  options?: DeclarativeShadowRootOptions
): ShadowRoot | null
```

`attachDeclarativeShadowRoot()`：

1. 已有 `shadowRoot` → 复用并登记样式；
2. 有 `<template shadowrootmode>` → 手动 `attachShadow()` 并搬运内容；
3. 都没有 → 返回 `null`。

`ReactiveElement.createRenderRoot()` 会自动调用它，因此普通组件只需要正常注册。

## Islands

### 为什么需要 Islands

整页 hydration 会把所有组件都接管，即使大部分内容永远不交互。Islands 允许：

- 服务端完整输出 HTML；
- 客户端只接管登记的 island；
- 按 `eager` / `idle` / `visible` / `interaction` 调度。

### 常量

```ts
const SSR_ISLAND_ATTRIBUTE = 'data-lania-island';
const SSR_ISLAND_PROPS_ATTRIBUTE = 'data-lania-island-props';
const SSR_ISLAND_ATTRIBUTE_NAME = 'data-lania-island-name';
const SSR_HYDRATED_ATTRIBUTE = 'data-lania-hydrated';
```

### `renderIsland()`

```ts
interface SSRIslandOptions extends DeclarativeShadowComponentOptions {
  priority?: 'eager' | 'idle' | 'visible' | 'interaction';
  name?: string;
}

interface SSRIslandRenderOptions extends SSRIslandOptions {
  props?: Record<string, unknown>;
}

renderIsland(html: string, options: SSRIslandRenderOptions): string
```

输出：

```html
<x-search-box
  data-lania-island="visible"
  data-lania-island-name="SearchBox"
  data-lania-island-props='{"query":"lania"}'
>
  <template shadowrootmode="open">...</template>
</x-search-box>
```

### `renderToStringAsIsland()`

```ts
renderToStringAsIsland(
  component: DeclarativeShadowComponentLike,
  props: Record<string, unknown>,
  options: SSRIslandRenderOptions
): string
```

```ts
const html = renderToStringAsIsland(SearchBox, { query: 'lania' }, {
  tagName: 'x-search-box',
  name: 'SearchBox',
  priority: 'visible',
  styles: SearchBox.styles,
});
```

### `ssrRenderIslandSlot()`

```ts
ssrRenderIslandSlot(
  slotIndex: number,
  component: unknown,
  props: unknown,
  priority: string,
  fallbackHtml?: string
): string
```

编译产物对 `<Child client:visible />` 的下沉入口。

行为：

1. 组件不可渲染 → 退回普通 block slot；
2. 组件可渲染 → 调用 `static render()`；
3. 写入 island 属性；
4. 包一层 block slot marker。

### props 序列化

```ts
serializeIslandProps(props?: Record<string, unknown>): string
parseIslandProps(value: string | null): Record<string, unknown>
```

规则：

| 值 | 处理 |
| --- | --- |
| 函数 / symbol | 丢弃并 warning |
| `bigint` | 转字符串 |
| 普通对象 / 数组 / 字符串 / 数字 / 布尔 | JSON |
| 解析失败 | `{}` |

### 客户端水合

```ts
interface IslandRecord {
  element: HTMLElement;
  name: string;
  priority: 'eager' | 'idle' | 'visible' | 'interaction';
  props: Record<string, unknown>;
}

interface HydrateIslandsOptions {
  root?: ParentNode;
  components?: Record<string, IslandComponentTarget>;
  priorities?: readonly IslandHydrationPriority[];
  onHydrate?: (record: IslandRecord) => void;
  onError?: (error: unknown, record: IslandRecord) => void;
}

type IslandComponentTarget =
  | CustomElementConstructor
  | (() => CustomElementConstructor | void | Promise<CustomElementConstructor | void>);

collectIslands(root: ParentNode): IslandRecord[]

hydrateIslandElement(record: IslandRecord): boolean

hydrateIslands(options?: HydrateIslandsOptions): Promise<IslandRecord[]>
```

#### `collectIslands()`

扫描 `[data-lania-island]` 且没有 `data-lania-hydrated` 的元素。

#### `hydrateIslandElement()`

1. 只回填组件声明的 props（`__laniaPropNames`）；
2. 移除 `data-lania-island-props`；
3. 组件尚未升级 → 返回 `false`，保留标记等待重试；
4. 调用 `element.hydrate()`；
5. 写入 `data-lania-hydrated`。

#### `hydrateIslands()`

```ts
await hydrateIslands({
  root: document,
  components: {
    SearchBox,
    HeavyChart: () => import('./HeavyChart.lania.tsx').then((mod) => mod.default),
  },
  priorities: ['eager', 'visible'],
  onHydrate: (record) => console.log('hydrated', record.name),
  onError: (error, record) => console.error(record.name, error),
});
```

`components` 的值可以是：

- 构造器；
- 返回构造器的函数；
- 异步函数，内部可自行 `customElements.define()`。

#### 优先级调度

| 优先级 | 调度 |
| --- | --- |
| `eager` | 立即加载并水合 |
| `idle` | `requestIdleCallback`，回退 `setTimeout(0)` |
| `visible` | `IntersectionObserver` 进入视口 |
| `interaction` | `pointerdown` / `focusin` / `click` |

非 `eager` 的组件代码也会等到触发器执行时才加载。

### 模板里的 `client:*`

```tsx
<SearchBox client:visible query={this.query()} />
<HeavyChart client:idle />
```

- `client:*` 不作为 prop 传递；
- SSR 时子组件使用自己的 `static render()`；
- 客户端由 `hydrateIslands()` 接管。

### `manual` 模式

```ts
MyIsland.hydration = 'manual';
```

连接后：

- 绑定 signals；
- 创建 render root；
- 注入样式；
- 不执行首屏挂载。

`hydrate()` 后才真正渲染。

## SSR 工具

```ts
ssrEscapeHtml(value: unknown): string
ssrSerializeAttribute(name: string, value: unknown): string

createSSRRenderContext(): SSRRenderContext
attachSSRRenderContext(...)

ssrRenderTextSlot(slotIndex: number, value: unknown): string
ssrRenderHtmlSlot(slotIndex: number, value: unknown): string
ssrRenderBlockSlot(...)
ssrRenderForSlot(...)
ssrRenderEnhancedBoundary(...)

ssrRenderTeleportSlot(...)
ssrRenderTeleportContainer(...)
ssrRenderAllTeleportContainers(...)

ssrRenderSuspenseBoundary(...)
ssrDrainSuspenseChunks(...)
applySSRChunk(root: Node, chunk: string): boolean

ssrEvaluate(expression: string, ctx?: Record<string, unknown>): unknown
ssrResolveValue<T>(value: T | Promise<T>): Promise<T>
```

| 工具 | 用途 |
| --- | --- |
| `ssrEscapeHtml` | HTML 转义 |
| `ssrSerializeAttribute` | 序列化 attribute，处理 boolean / class / style |
| `ssrRenderTextSlot` | 输出文本 slot marker |
| `ssrRenderBlockSlot` | 输出结构块 marker |
| `ssrRenderTeleportContainer` | 输出 teleport 容器 |
| `ssrRenderSuspenseBoundary` | 输出 Suspense 边界 |
| `applySSRChunk` | 把异步 chunk 应用回 DOM |
| `ssrEvaluate` | 在受限上下文中求值表达式 |

这些函数主要供编译产物与自定义 SSR 集成使用。

## marker 协议

```ts
type EnhancedMarkerKind =
  | 'block-start'
  | 'block-end'
  | 'boundary-start'
  | 'boundary-end'
  | 'teleport-anchor'
  | 'cache-anchor'
  | 'transition-anchor';

type HydrationRecoveryMode = 'resume' | 'replay' | 'remount';
type BoundaryState = 'idle' | 'pending' | 'resolved' | 'rejected' | 'inactive';
```

客户端通过注释 marker 恢复：

- 动态 slot 的位置；
- 条件分支；
- 列表项；
- Suspense / ErrorBoundary 状态；
- Teleport 容器；
- KeepAlive / Transition 锚点。

## 完整示例

```ts
// server.ts
import {
  renderToStringWithDeclarativeShadow,
  renderToStringAsIsland,
} from '@lania-v/runtime';

import App from './App.lania.tsx';
import SearchBox from './SearchBox.lania.tsx';

const appHtml = renderToStringWithDeclarativeShadow(App, { title: 'lania' }, {
  tagName: 'x-app',
  styles: App.styles,
});

const searchHtml = renderToStringAsIsland(SearchBox, { query: 'lania' }, {
  tagName: 'x-search-box',
  name: 'SearchBox',
  priority: 'visible',
  styles: SearchBox.styles,
});

const html = `
  <!doctype html>
  <html>
    <body>
      ${appHtml}
      ${searchHtml}
      <script type="module" src="/client.js"></script>
    </body>
  </html>
`;
```

```ts
// client.ts
import { hydrateIslands } from '@lania-v/runtime';
import SearchBox from './SearchBox.lania.tsx';

await hydrateIslands({
  components: {
    SearchBox,
    HeavyChart: () => import('./HeavyChart.lania.tsx').then((mod) => mod.default),
  },
});
```

## 注意事项

- `renderToString()` 不等待异步内容；
- island props 必须可 JSON 序列化；
- 样式在 SSR 内联，客户端通过 `registerAppliedStyleTexts()` 去重；
- `manual` 组件不会自动挂载；
- Teleport 目标容器必须在 hydration 时存在；
- `data-lania-island-props` 会在水合后移除。
