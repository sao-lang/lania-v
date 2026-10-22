# 构建与部署

这一页讲产物形态与上线方式：`vite build` 之后剩下什么、静态托管怎么做、SSR 与 Islands 怎么部署。

## 构建时发生了什么

```text
.lania.tsx
  → Vite transform（插件，enforce: 'pre'）
  → 编译器：Component IR → renderPlan → 模块代码
  → TypeScript 转译（ES2022 / ESNext）
  → Rollup 打包
  → dist/
```

开发态与生产态的区别：

| 项               | `vite dev`                                    | `vite build`                 |
| ---------------- | --------------------------------------------- | ---------------------------- |
| 编译快照         | `debug: true` 时输出，并注入 `__laniaCompile` | 不注入                       |
| HMR              | 模块尾部追加 `import.meta.hot.accept()`       | 不追加                       |
| `__laniaSetup()` | `hotReload: true` 时生成                      | 不生成                       |
| 调试事件         | 由 `__DEV__` 决定                             | 由 `production` 条件导出决定 |
| 编译器           | 在 Vite 进程里                                | 不在产物里                   |

因此生产包只包含：组件类、运行时（Signal / Scheduler / Slot / Updater）、增强组件实现，以及你的业务代码。

## 产物结构

一次普通的 `vite build`：

```text
dist/
├── index.html
└── assets/
    ├── index-<hash>.js
    └── index-<hash>.css
```

- 每个 `.lania.tsx` 变成一个组件类，并在模块求值时注册自定义元素；
- 样式通过 `Component.styles` 进入 Shadow Root，不产生全局 CSS；
- `.lania.tsx` 的 sourcemap 指回原始文件，生产环境排错时仍然可读。

## 静态部署

lania-v 本身不包含路由，页面怎么切分由宿主决定。

### 单页应用

```ts
// main.tsx
import { createRoot } from '@lania-v/runtime';
import App from './App.lania.tsx';

createRoot(document.querySelector('#app')!).render(<App />);
```

部署时需要把未知路径回退到 `index.html`：

| 平台         | 配置                                                          |
| ------------ | ------------------------------------------------------------- |
| Nginx        | `try_files $uri $uri/ /index.html;`                           |
| Netlify      | `[[redirects]] from = "/*" to = "/index.html" status = 200`   |
| Vercel       | `rewrites: [{ source: '/(.*)', destination: '/index.html' }]` |
| GitHub Pages | 使用 `404.html` 回退，或改用 hash 路由                        |

如果 `base` 不是 `/`，记得同步构建配置：

```ts
export default defineConfig({
  base: '/my-app/',
});
```

### 多页应用

每页一个入口，各自挂载自己的组件。lania-v 的组件可以单独分发，因此 MPA 是它最自然的形态之一：

```ts
build: {
  rollupOptions: {
    input: {
      home: 'index.html',
      docs: 'docs/index.html',
    },
  },
}
```

### 与其它框架共存

一个页面里可以同时存在 React / Vue 外壳与 lania-v 组件：

```tsx
// React 侧
import 'my-lania-components'; // 触发 customElements.define

export function Panel() {
  return <my-panel title="hello" />;
}
```

注意两点：

- 组件必须在被使用前完成注册；
- 通过属性传对象时，用 ref 或在 `useEffect` 里赋值，不要依赖 JSX 的属性序列化。

## SSR 部署

### 最小 Node 服务

```ts
import { createServer } from 'node:http';
import { renderToStringWithDeclarativeShadow } from '@lania-v/runtime';
import App from './App.lania.tsx';

createServer((req, res) => {
  const app = renderToStringWithDeclarativeShadow(App, {}, { mode: 'open' });

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8" /><title>lania-v</title></head>
  <body>
    <div id="app">${app}</div>
    <script type="module" src="/assets/index.js"></script>
  </body>
</html>`);
}).listen(3000);
```

要点：

- 服务端与客户端共用同一份编译产物；
- `renderToString()` 不等待异步内容，需要补丁时走 Suspense 相关 API；
- 输出的是 DSD 模板 + 注释标记，客户端由组件自身接管。

### 流式渲染

```ts
import { renderToStream } from '@lania-v/runtime';

for await (const chunk of renderToStream(App, props)) {
  res.write(chunk);
}
res.end();
```

流式返回时注意不要提前结束响应，也不要在 chunk 之间插入会被浏览器当成正文的 HTML 片段。

### DSD 的浏览器支持

自定义元素连接时会调用 `attachDeclarativeShadowRoot()`：

- 原生支持 DSD 的浏览器直接复用已有的 `shadowRoot`；
- 不支持的浏览器读取 `<template shadowrootmode>` 内容并手动 `attachShadow()`；
- 两条路径都会登记已有样式，避免重复注入。

也就是说：**不需要为老浏览器准备第二套输出**，客户端接管逻辑已经覆盖。

## Islands 部署

Islands 适合「大部分静态、少数交互块」的页面：服务端输出 DSD，客户端只水合需要的部分。

```ts
import { hydrateIslands } from '@lania-v/runtime';
import SearchBox from './SearchBox.lania.tsx';

await hydrateIslands({
  root: document,
  components: {
    SearchBox,
    HeavyChart: () =>
      import('./HeavyChart.lania.tsx').then((mod) => mod.default),
  },
  priorities: ['eager', 'visible'],
});
```

| 优先级        | 触发时机   |
| ------------- | ---------- |
| `eager`       | 立即水合   |
| `idle`        | 浏览器空闲 |
| `visible`     | 进入视口   |
| `interaction` | 首次交互   |

部署建议：

- 只有真正需要的组件传给 `components`，其余保持静态；
- 重组件用动态 `import()`，让水合代码单独分包；
- 给 island 元素留出稳定尺寸，避免水合后布局跳动。

## 性能要点

| 做法                                     | 原因                                               |
| ---------------------------------------- | -------------------------------------------------- |
| 保持 `sideEffects` 正确                  | 运行时与插件都声明了 `sideEffects`，避免整包被打入 |
| 用 `lazy()` / 动态 `import()` 切分重组件 | 首屏只加载用到的组件                               |
| 长列表用 `<Each>` 配稳定 key             | 减少节点复用带来的重建                             |
| 高频事件用 `enableEventDelegation()`     | 同一 root 上同事件只挂一条监听                     |
| 少在模板里做大对象构造                   | 表达式会随依赖重算                                 |
| 生产构建显式 `__LANIA_DEV__: 'false'`    | 去掉调试事件与警告分支                             |

## 部署检查清单

- [ ] `vite build` 通过，产物里没有 `__laniaCompile`
- [ ] 生产环境 `__DEV__` 为 `false`（或使用 `/prod` 入口）
- [ ] 静态托管的回退规则正确（SPA 需要回退到 `index.html`）
- [ ] `base` 与部署路径一致
- [ ] 组件标签名没有冲突，且在被使用前完成注册
- [ ] SSR 场景下服务端与客户端使用同一份编译产物
- [ ] Islands 只水合必要组件，重组件使用动态导入
- [ ] 开启了 sourcemap，便于线上排错

## 下一步

- [工程配置](/guide/configuration)：构建相关的全部配置项。
- [SSR 与部分水合](/guide/ssr)：渲染与接管细节。
- [常见问题与排错](/guide/troubleshooting)：上线后的典型症状。
