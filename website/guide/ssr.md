# SSR 与部分水合

`lania-v` 的 SSR 复用同一份编译产物：编译器会为组件生成 `static render()` 与 `static renderStream()`，服务端只需调用它们。

## 字符串渲染

```ts
import { renderToString } from '@lania-v/runtime';
import App from './App.lania.tsx';

const html = renderToString(App, { title: 'hello' });
```

`renderToString()` 要求组件上存在 `static render()`，否则抛出 `TypeError`。

流式渲染：

```ts
import { renderToStream } from '@lania-v/runtime';

for await (const chunk of renderToStream(App, { title: 'hello' })) {
  response.write(chunk);
}
```

## Declarative Shadow DOM

### 输出带 DSD 的完整元素

```ts
import { renderToStringWithDeclarativeShadow } from '@lania-v/runtime';

const html = renderToStringWithDeclarativeShadow(
  App,
  { title: 'hello' },
  {
    tagName: 'x-app',
    styles: App.styles,
    mode: 'open',
  }
);
```

输出形态：

```html
<x-app>
  <template shadowrootmode="open">
    <style data-lania-ssr-style>
      ...
    </style>
    <!-- 组件 HTML -->
  </template>
</x-app>
```

`renderMode = 'light'` 的组件会输出普通 HTML，而不是 DSD 模板：

```ts
import { renderLightComponent } from '@lania-v/runtime';

const html = renderLightComponent('<p>hello</p>', {
  tagName: 'x-hello',
  styles,
});
```

### 流式 DSD

```ts
import { renderStreamToDeclarativeShadow } from '@lania-v/runtime';

for await (const chunk of renderStreamToDeclarativeShadow(App, props, {
  tagName: 'x-app',
  styles: App.styles,
})) {
  response.write(chunk);
}
```

首块就包含宿主开标签与内联样式，避免流式传输时先看到无样式内容。

### 选项

```ts
interface DeclarativeShadowComponentOptions {
  tagName: string;
  mode?: 'open' | 'closed';
  styles?: StaticStyles;
  delegatesFocus?: boolean;
  attributes?: Record<string, unknown> | string;
  lightDom?: string;
  renderMode?: 'shadow' | 'light';
  inlineStyles?: boolean;
}
```

| 选项             | 说明                               |
| ---------------- | ---------------------------------- |
| `tagName`        | 自定义元素标签名                   |
| `mode`           | shadow root 模式                   |
| `styles`         | 内联进 shadow root 的静态样式      |
| `delegatesFocus` | 输出 `shadowrootdelegatesfocus`    |
| `attributes`     | 宿主 attribute                     |
| `lightDom`       | 宿主 light DOM，用于 `<slot>` 投影 |
| `renderMode`     | 覆盖组件声明的渲染模式             |
| `inlineStyles`   | light 模式是否内联样式             |

## 客户端接管 DSD

自定义元素连接到 DOM 时会调用 `attachDeclarativeShadowRoot()`：

- 浏览器原生支持 DSD 时，复用已有 `shadowRoot`；
- 不支持时，读取 `<template shadowrootmode>` 内容并手动 `attachShadow()`；
- 两种路径都会登记已有样式，避免后续重复注入。

因此普通组件只需要正常注册：

```ts
import App from './App.lania.tsx';

customElements.define('x-app', App);
```

## 部分水合（Islands）

### 输出 island

```ts
import { renderIsland, renderToStringAsIsland } from '@lania-v/runtime';

const html = renderToStringAsIsland(
  SearchBox,
  { query: 'lania' },
  {
    tagName: 'x-search-box',
    name: 'SearchBox',
    priority: 'visible',
    styles: SearchBox.styles,
  }
);
```

输出元素会带上：

```html
<x-search-box
  data-lania-island="visible"
  data-lania-island-name="SearchBox"
  data-lania-island-props='{"query":"lania"}'
>
  <template shadowrootmode="open">...</template>
</x-search-box>
```

props 序列化规则：

- 只支持可 JSON 序列化的值；
- 函数 / symbol 会被丢弃，并输出 warning；
- `bigint` 会转成字符串；
- 解析失败时回退为空对象。

### 客户端水合

```ts
import { hydrateIslands } from '@lania-v/runtime';
import SearchBox from './SearchBox.lania.tsx';
import HeavyChart from './HeavyChart.lania.tsx';

await hydrateIslands({
  root: document,
  components: {
    SearchBox,
    HeavyChart: () =>
      import('./HeavyChart.lania.tsx').then((mod) => mod.default),
  },
  priorities: ['eager', 'visible'],
  onHydrate: (record) => console.log('hydrated', record.name),
  onError: (error, record) => console.error(record.name, error),
});
```

`components` 的值可以是：

- 组件构造器；
- 一个函数，返回构造器；
- 一个异步函数，内部自行 `customElements.define()`。

```ts
interface HydrateIslandsOptions {
  root?: ParentNode;
  components?: Record<
    string,
    | CustomElementConstructor
    | (() =>
        | CustomElementConstructor
        | void
        | Promise<CustomElementConstructor | void>)
  >;
  priorities?: readonly ('eager' | 'idle' | 'visible' | 'interaction')[];
  onHydrate?: (record: IslandRecord) => void;
  onError?: (error: unknown, record: IslandRecord) => void;
}
```

### 四档优先级

| 优先级        | 触发时机                                        |
| ------------- | ----------------------------------------------- |
| `eager`       | 立即加载并水合                                  |
| `idle`        | `requestIdleCallback`，不支持时 `setTimeout(0)` |
| `visible`     | `IntersectionObserver` 进入视口                 |
| `interaction` | `pointerdown` / `focusin` / `click`             |

非 `eager` island 的组件代码也会等到触发器执行时才加载，避免拖慢首屏。

### 模板里的 `client:*`

```tsx
<SearchBox client:visible query={this.query()} />
<HeavyChart client:idle />
```

`client:*` 不会作为 prop 传给子组件。SSR 时子组件使用自己的 `static render()` 输出内容；客户端由 `hydrateIslands()` 按优先级接管。

::: tip manual 模式
需要延迟水合的组件可以声明：

```ts
MyIsland.hydration = 'manual';
```

这样组件连接 DOM 后只接管 shadow root / 样式，不立即挂载，等 `hydrate()` 或 island 调度器调用。
:::

## 组件级水合策略

`ReactiveElement` 上有两个静态配置：

```ts
MyComponent.renderMode = 'shadow' | 'light';
MyComponent.hydration = 'eager' | 'manual';
```

| 配置         | 默认     | 说明                     |
| ------------ | -------- | ------------------------ |
| `renderMode` | `shadow` | 渲染根                   |
| `hydration`  | `eager`  | 是否等待显式 `hydrate()` |

`manual` 组件在 `hydrate()` 之前：

- 保留 SSR 内容；
- `isHydrated` 为 `false`；
- 不执行首屏 `_renderAndMount()`。

## SSR 标记协议

SSR 使用注释节点标记动态区间：

- block start / end；
- boundary start / end；
- teleport anchor；
- cache anchor；
- transition anchor。

客户端水合时通过这些 marker 恢复：

- Slot 节点位置；
- 条件分支；
- 列表项；
- Suspense / ErrorBoundary 状态；
- Teleport 容器。

标记与 payload 协议定义在 `@lania-v/shared`，运行时通过 `parseBoundaryMarker()` 等工具读取。

## 注意事项

- SSR 输出的是 DOM 结构，不是 VNode 序列化；
- `renderToString()` 不等待异步内容；需要异步补丁时使用 Suspense 相关 API；
- `styles` 会在 SSR 阶段内联，客户端通过 `registerAppliedStyleTexts()` 去重；
- island props 必须是可序列化数据。

## 下一步

- [SSR API](/api/ssr)：完整签名。
- [开发与调试](/guide/dev-and-debug)：`__lania` 检查器与 HMR。
- [整体架构](/advanced/architecture)：SSR 在架构中的位置。
