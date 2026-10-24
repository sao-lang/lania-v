# 工程配置

这一页把「一个 lania-v 项目需要配置什么」集中讲清楚：Vite、TypeScript、JSX 类型、运行时入口、构建开关与 SSR。

单个配置项的完整语义见 [Vite 插件](/api/plugin)；这里只讲它们怎么组合起来用。

## 配置文件总览

| 文件             | 作用                                | 必需 |
| ---------------- | ----------------------------------- | ---- |
| `vite.config.ts` | 注册插件、设置 JSX 运行时与构建目标 | 是   |
| `tsconfig.json`  | 让编辑器和 `tsc` 认识 `.lania.tsx`  | 是   |
| `src/jsx.d.ts`   | 声明 JSX 命名空间与增强组件标签     | 是   |
| `package.json`   | 依赖、脚本、`sideEffects`           | 是   |

## `vite.config.ts`

```ts
import { defineConfig } from 'vite';
import { laniaFcVitePlugin } from '@lania-v/vite-plugin';

export default defineConfig({
  plugins: [laniaFcVitePlugin()],
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: '@lania-v/runtime',
  },
});
```

两条约束：

1. **插件必须是 `enforce: 'pre'`**（插件内部已经设置）。它要在其它 TS/JSX 插件之前把 `.lania.tsx` 改写成普通模块。
2. **`esbuild.jsxImportSource` 必须指向 `@lania-v/runtime`**。插件只处理 `.lania.tsx`，`main.tsx` 等普通 TSX 仍由 Vite 转译，这些文件也需要 lania-v 的 JSX 运行时。

### 按环境拆分

```ts
import { defineConfig } from 'vite';
import { laniaFcVitePlugin } from '@lania-v/vite-plugin';

export default defineConfig(({ command }) => ({
  plugins: [
    laniaFcVitePlugin({
      debug: command === 'serve',
      hotReload: command === 'serve',
    }),
  ],
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: '@lania-v/runtime',
  },
  define: command === 'build' ? { __LANIA_DEV__: 'false' } : undefined,
}));
```

`debug` 与 `hotReload` 本身只在 `vite dev` 下生效，这里显式写出来是为了让意图可见。

## 插件选项

| 选项              | 默认              | 作用                                      |
| ----------------- | ----------------- | ----------------------------------------- |
| `tsxInclude`      | `/\.lania\.tsx$/` | 需要编译的文件                            |
| `tsxExclude`      | `undefined`       | 排除规则（例如 `node_modules`）           |
| `debug`           | `false`           | 开发态输出编译快照并注入 `__laniaCompile` |
| `hotReload`       | `true`            | 开发态生成可重跑的 `__laniaSetup()`       |
| `compilerPlugins` | `undefined`       | 传给 `compiler-core` 的插件数组           |

```ts
laniaFcVitePlugin({
  tsxExclude: /node_modules/,
  compilerPlugins: [statsPlugin],
});
```

选项细节、编译快照的内容与 HMR 语义见 [Vite 插件](/api/plugin) 和 [开发与调试](/guide/dev-and-debug)。

## TypeScript

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "jsxImportSource": "@lania-v/runtime",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts"]
}
```

关键项：

| 选项                                  | 为什么                                          |
| ------------------------------------- | ----------------------------------------------- |
| `jsx: "react-jsx"`                    | 走自动 JSX 运行时，不注入 `React.createElement` |
| `jsxImportSource: "@lania-v/runtime"` | JSX 类型与运行时都来自 lania-v                  |
| `moduleResolution: "Bundler"`         | 解析 `exports` 里的条件导出与子路径             |
| `allowImportingTsExtensions`          | 允许 `import './X.lania.tsx'` 这类带扩展名导入  |
| `types: ["vite/client"]`              | 提供 `import.meta.hot` 等类型                   |

### `jsx.d.ts`

```ts
type RuntimeIntrinsicElementProps =
  import('@lania-v/runtime/jsx-runtime').LaniaIntrinsicElementProps<HTMLElement>;
type RuntimeNativeIntrinsicElements =
  import('@lania-v/runtime/jsx-runtime').LaniaNativeIntrinsicElements;
type RuntimeEnhancedIntrinsicElements =
  import('@lania-v/runtime/jsx-runtime').LaniaEnhancedIntrinsicElements;

declare namespace JSX {
  type Element = import('@lania-v/runtime/jsx-runtime').LaniaJsxElement;

  interface ElementChildrenAttribute {
    children: {};
  }

  interface IntrinsicAttributes {
    key?: unknown;
  }

  interface IntrinsicElements
    extends
      RuntimeNativeIntrinsicElements,
      RuntimeEnhancedIntrinsicElements,
      Record<string, RuntimeIntrinsicElementProps> {}
}
```

没有这份声明时，`<When>`、`<Each>` 等增强组件标签与自定义元素标签都会报「未知元素」。

## 组件标签

标签名由编译器推导，不需要手写注册：

| 组件名                            | 标签        |
| --------------------------------- | ----------- |
| `Counter`                         | `x-counter` |
| `TodoList`                        | `todo-list` |
| 显式 `static tagName = 'my-card'` | `my-card`   |

推导规则见 [组件 · 标签名](/guide/components#标签名)。已有的第三方自定义元素可以直接在 JSX 里使用。

## 环境与调试开关

运行时通过 `__DEV__` 决定是否发出警告与调试事件。它的来源有优先级：

```ts
// packages/runtime/src/core/env.ts 的等价逻辑
export const __DEV__ =
  typeof __LANIA_DEV__ === 'boolean'
    ? __LANIA_DEV__
    : typeof process === 'undefined' || process.env.NODE_ENV !== 'production';
```

因此有三条可控路径：

| 方式                                 | 适用场景                                                        |
| ------------------------------------ | --------------------------------------------------------------- |
| Vite 条件导出（默认）                | `vite build` 会解析 `production` 条件，自动使用 `index.prod.js` |
| `define: { __LANIA_DEV__: 'false' }` | 打包器不支持条件导出，或需要强制取值                            |
| `import '@lania-v/runtime/prod'`     | 测试 / 特殊构建，强制关闭调试                                   |

反向同理：测试环境可以 `import '@lania-v/runtime/dev'` 打开全部调试事件。

::: tip 排查「生产环境还在打日志」
先确认构建产物里 `__DEV__` 的取值来源。自定义打包链路（非 Vite / 非条件导出）需要显式 define 或改用 `/prod` 入口。
:::

## 构建配置

```ts
export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: '@lania-v/runtime',
  },
});
```

| 项                | 建议                                                           |
| ----------------- | -------------------------------------------------------------- |
| `build.target`    | `es2022`。运行时依赖 class fields 与可选链                     |
| `build.sourcemap` | 开发与预发建议开启；编译产物的 sourcemap 会对齐回 `.lania.tsx` |
| `define`          | 生产构建建议显式写 `__LANIA_DEV__: 'false'`                    |

`.lania.tsx` 在构建期就被编译成普通模块，产物里不含编译器，也不含 HMR 包装。

## 库模式

把组件作为包分发时，运行时应当是外部依赖：

```ts
export default defineConfig({
  plugins: [laniaFcVitePlugin()],
  esbuild: { jsx: 'automatic', jsxImportSource: '@lania-v/runtime' },
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
    },
    rollupOptions: {
      external: ['@lania-v/runtime'],
    },
  },
});
```

组件最终是自定义元素，因此库模式下要注意：

- 标签名要全局唯一，建议统一前缀；
- 样式随 `Component.styles` 进入 Shadow Root，不依赖宿主的 CSS；
- 不要在库里重复打包 `@lania-v/runtime`，否则会出现两份响应式系统。

## SSR

```ts
export default defineConfig({
  plugins: [laniaFcVitePlugin()],
  esbuild: { jsx: 'automatic', jsxImportSource: '@lania-v/runtime' },
  build: {
    ssr: 'src/entry-server.tsx',
  },
});
```

服务端入口只调用运行时的渲染函数：

```ts
import { renderToStringWithDeclarativeShadow } from '@lania-v/runtime';
import App from './App.lania.tsx';

export const render = (props: Record<string, unknown>) =>
  renderToStringWithDeclarativeShadow(App, props, { mode: 'open' });
```

| 配置点                           | 说明                                                                    |
| -------------------------------- | ----------------------------------------------------------------------- |
| 服务端与客户端共用同一份编译产物 | 组件类上已经生成 `static render()` / `renderStream()`                   |
| 组件级渲染模式                   | `static renderMode = 'shadow' \| 'light'`                               |
| 组件级水合策略                   | `static hydration = 'eager' \| 'manual'`                                |
| Island 标记                      | `client:load` / `client:idle` / `client:visible` / `client:interaction` |

完整流程见 [SSR 与部分水合](/guide/ssr) 与 [SSR API](/api/ssr)。

## Monorepo 与路径别名

本仓库用 npm workspaces，`node_modules/@lania-v/*` 直接指向 `packages/*` 源码。如果你也在 monorepo 里开发：

```ts
resolve: {
  alias: {
    '@lania-v/runtime': fileURLToPath(new URL('./packages/runtime/src/index.ts', import.meta.url)),
  },
},
```

注意别名只应指向**一个**入口。同时命中 `src` 与 `dist` 会导致运行时出现两份 Signal 实现，表现为「set 了但视图不更新」。

## 配置检查清单

- [ ] `vite.config.ts` 注册了 `laniaFcVitePlugin()`
- [ ] `esbuild.jsxImportSource` 指向 `@lania-v/runtime`
- [ ] `tsconfig.json` 的 `jsx` 是 `react-jsx`，`jsxImportSource` 同上
- [ ] 存在 `src/jsx.d.ts`，编辑器不报未知标签
- [ ] 生产构建里 `__LANIA_DEV__` 为 `false`（或使用 `/prod` 入口）
- [ ] `@lania-v/runtime` 在产物中只有一份
- [ ] `.lania.tsx` 文件名与 `tsxInclude` 匹配

## 下一步

- [构建与部署](/guide/build-and-deploy)：产物形态与上线方式。
- [Vite 插件](/api/plugin)：选项的完整语义。
- [常见问题与排错](/guide/troubleshooting)：配置写错时的典型症状。
