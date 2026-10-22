# SSR / Hydration 文档

本文档描述 `lania-v` 当前已经落地的 SSR / Hydration 能力。

## 当前定位

当前实现已经覆盖基础模板 SSR、增强边界协议、Teleport 跨容器 SSR 和 Suspense 流式回填：

- 支持 slot marker
- 支持增强边界 marker 与元信息序列化
- 支持客户端 hydration 复用现有 DOM
- 支持恢复 slot table 和运行时 updater 绑定
- 支持 Teleport 目标容器输出与 hydration 对齐
- 支持 Suspense 流式 chunk 输出与客户端 patch 回填

## 服务端入口

编译产物已经生成 `static render()` / `static renderStream()`，运行时提供两个薄入口：

```ts
import { renderToString, renderToStream } from '@lania-v/runtime';

const html = renderToString(App, { title: 'hello' });

for await (const chunk of renderToStream(App, { title: 'hello' })) {
  // 写入流
}
```

当前入口只负责调用编译产物上的静态方法；应用级编排（路由、数据预取）仍由上层层决定。
Declarative Shadow DOM 与部分水合已由运行时提供协议层（见后文），上层只需选择用哪个入口。

## Declarative Shadow DOM

编译产物默认渲染进 Shadow DOM，因此服务端输出也需要对应的 `<template shadowrootmode>`，
否则客户端接管后会出现 `light DOM 内容 + shadow 内容` 的重复。

推荐入口是 `renderComponentToString()`：它读取组件声明的 `renderMode`，自动选择输出形态。

```ts
import {
  renderComponentToString,
  renderComponentToStream,
} from '@lania-v/runtime';

// 组件未声明 renderMode 时按 shadow 输出 DSD
const html = renderComponentToString(
  App,
  { title: 'hello' },
  {
    tagName: 'app-root',
    attributes: { title: 'hello' },
  }
);
// shadow: <app-root title="hello"><template shadowrootmode="open">…</template></app-root>
// light : <app-root title="hello">…</app-root>

for await (const chunk of renderComponentToStream(App, props, {
  tagName: 'app-root',
})) {
  // shadow: 首块自带内联样式，最后一块闭合模板与宿主
  // light : 首块写宿主开标签与样式，最后一块直接闭合宿主
}
```

`renderMode = 'light'` 的组件**必须**走 light 分支：DSD 会创建一个组件永远不会使用的
shadow root，SSR 内容因此不可见，客户端又会往 light DOM 渲染一份。

低层入口仍然可用（`renderToStringWithDeclarativeShadow()` /
`renderStreamToDeclarativeShadow()` 是它们的别名，同样会按 `renderMode` 分派）：

```ts
renderDeclarativeShadowRoot('<p>hi</p>', {
  styles: css`
    p {
      color: red;
    }
  `,
});
renderDeclarativeShadowComponent('<p>hi</p>', { tagName: 'my-card' });
renderLightComponent('<p>hi</p>', { tagName: 'my-card' });
```

协议细节：

- 静态样式会内联成 `<style data-lania-ssr-style>`，首屏不再出现无样式闪烁；
- 客户端 `createRenderRoot()` 会优先接管宿主里未被消费的 `<template shadowrootmode>`，
  平台原生支持时直接复用 `element.shadowRoot`；
- 接管后会把 shadow root 里已有的 `<style>` 文本登记为“已注入”，
  hydration 时 `adoptStyles()` 不会重复注入；
- `renderDeclarativeShadowRoot()` / `renderDeclarativeShadowComponent()`
  是不依赖编译产物的低层入口，可自行拼接字符串。

## 部分水合（islands）

### 编译期声明（推荐）

```tsx
// 父组件里直接标记子组件的水合优先级
<SearchBox client:visible query={this.query()} />
<HeavyChart client:idle />
<Tooltip client:interaction label="hint" />
```

- 编译器把 `client:<priority>` 识别为 island 声明，**不会**把它当作 prop 传给子组件；
- SSR 时由 `ssrRenderIslandSlot()` 调用子组件自己的 `static render()` 输出内容，
  再包成带 island 元信息的宿主（shadow 组件是 DSD，light 组件是普通 HTML）；
- 客户端元素一旦带 `data-lania-island`，升级后会自动保持静态，等 `hydrateIslands()` 调度；
- 只支持组件标签；原生标签上的 `client:*` 会在编译期报错。

### 手动输出

```ts
import { renderToStringAsIsland } from '@lania-v/runtime';

const html =
  renderToStringAsIsland(
    SearchBox,
    { query: 'a' },
    {
      tagName: 'search-box',
      priority: 'visible',
    }
  ) + renderToStringAsIsland(Footer, {}, { tagName: 'app-footer' });
```

### 客户端

```ts
await hydrateIslands({
  root: document.body,
  components: {
    'search-box': () => import('./search-box.lania'),
  },
  onHydrate: (record) => console.log('hydrated', record.name),
});
```

协议细节：

- SSR 会写入 `data-lania-island`（优先级）、`data-lania-island-name`、`data-lania-island-props`；
- props 只支持可 JSON 序列化的值，函数/symbol 会被丢弃并在开发态告警；
- 优先级：`eager`（立即）、`idle`（`requestIdleCallback`）、`visible`（`IntersectionObserver`）、
  `interaction`（首次 `pointerdown` / `focusin` / `click`）；
- `static hydration = 'manual'` 或带 `data-lania-island` 的元素在 `hydrate()` 之前只接管
  shadow root 与样式，不执行 `_renderAndMount()`，因此 SSR 内容保持原样；
- 水合时只回填组件声明的 prop（按 `static __laniaPropNames`），`children` 等结构字段由 SSR 内容承载；
- 水合完成后宿主元素会带 `data-lania-hydrated`，重复调度不会二次挂载；
- 组件未注册时保持静态并给出开发态告警，等注册后可再次调度。

## 服务端输出

服务端输出基于静态模板和 slot 标记：

- 文本 slot 使用文本 SSR 输出
- 条件、列表、dynamic、teleport 使用 block slot 标记
- 增强组件边界使用独立 boundary marker
- 条件分支当前优先复用静态模板信息

`Teleport`、`Suspense` 与增强边界会带元信息：

- `Teleport`: `to`
- `Suspense`: `boundaryId / suspenseKey / status`
- 增强边界：`component + key-like metadata`
- `if`: `strategy: "static-template"`

## 关键 API

### `ssrEvaluate()`

在服务端上下文里求值表达式。

### `ssrEscapeHtml()`

输出 HTML 安全字符串。

### `ssrRenderTextSlot()`

为文本 slot 生成 SSR 结果。

### `ssrRenderBlockSlot()`

为条件、列表、dynamic、teleport 生成 block slot 和 marker。

### `ssrRenderEnhancedBoundary()`

为 `Suspense / ErrorBoundary / KeepAlive / LazyLoad / Transition /
TransitionGroup` 输出 SSR 边界 marker。

### `ssrRenderTeleportSlot()` / `ssrRenderTeleportContainer()`

把 Teleport 主树占位和目标容器内容拆开输出。

### `ssrRenderSuspenseBoundary()` / `ssrDrainSuspenseChunks()` / `applySSRChunk()`

用于 Suspense 的流式 fallback、异步 chunk 回填和客户端 patch 应用。

### `renderToStringWithDeclarativeShadow()` / `renderStreamToDeclarativeShadow()`

别名入口，同样按 `renderMode` 分派（只对 shadow 组件输出 DSD 模板）。

### `attachDeclarativeShadowRoot()` / `readDeclarativeShadowTemplate()`

客户端接管未被平台消费的 DSD 模板，作为不支持 DSD 环境的降级路径。

### `renderComponentToString()` / `renderComponentToStream()`

按组件声明的 `renderMode` 输出宿主元素：shadow 走 DSD，light 走普通 HTML。

### `renderToStringAsIsland()` / `hydrateIslands()` / `collectIslands()`

部分水合的 SSR 输出、调度入口与 DOM 采集工具；编译期可用 `<Child client:visible />` 声明。

## Hydration

客户端 hydration 会执行以下步骤：

1. 挂载静态模板或识别现有 DOM
2. 扫描 hydration markers
3. 重建 slot table
4. 扫描增强边界与边界元信息
5. 恢复 runtime updater 绑定
6. 复用已有 DOM，避免重复创建节点
7. Teleport 从目标容器恢复已有节点

## 运行时结构

`mountStaticTemplate()` 返回：

- `nodes`
- `hydrated`
- `hydrationSlots`
- `hydrationBoundaries`

每个 hydration slot 会记录：

- `index`
- `start`
- `end`
- `contentNodes`
- `kind`
- `metadata`

## 当前支持范围

- 文本内容 SSR
- 属性序列化
- 条件分支基础版 SSR
- 列表 slot marker
- dynamic / teleport 边界 marker
- 增强组件 SSR 边界元信息
- Teleport 跨容器 SSR 输出
- Suspense 流式 fallback + chunk 回填
- Declarative Shadow DOM 输出与客户端接管（含 `<style>` 去重）
- 按 `renderMode` 分派 SSR 输出（light 模式不再产生双份内容）
- 部分水合：island 元信息、props 序列化与四档水合优先级
- 编译期 island 标记：`<Child client:visible />`
- 客户端 hydration 复用 DOM

## 当前边界

- 条件分支 SSR 仍然采用静态模板策略，不是更激进的分支级代码生成方案。
- Suspense 的客户端恢复协议已具备，但复杂异步组件树仍建议优先参考测试路径验收。
- DSD 只覆盖“组件自身的 shadow root”，跨组件的嵌套 shadow 树仍由各自组件的 SSR 输出决定。
- 部分水合只调度到自定义元素边界；island 的 props 必须可 JSON 序列化（函数/插槽不可跨网络）。
