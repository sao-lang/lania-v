# Vite 插件

`@lania-v/vite-plugin` 只做三件事：

1. 拦截 `.lania.tsx`；
2. 调用编译器生成模块代码；
3. 把结果交还给 Vite，并在开发态注入 HMR。

它不接管普通 `.tsx`，也不改变 Vite 的模块图。

## 安装与配置

```bash
npm install -D @lania-v/vite-plugin
```

```ts
// vite.config.ts
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

为什么还需要 `esbuild.jsxImportSource`：

- 插件只编译 `.lania.tsx`；
- `main.tsx`、普通 `.tsx` 仍由 Vite / esbuild 转译；
- 这些文件的 JSX 必须指向 `@lania-v/runtime/jsx-runtime`。

## 选项

```ts
interface LaniaFcVitePluginOptions {
  compilerPlugins?: CompilerPlugin[];
  tsxInclude?: RegExp;
  tsxExclude?: RegExp;
  debug?: boolean;
  hotReload?: boolean;
}

type LaniaVitePluginOptions = LaniaFcVitePluginOptions;
```

### `compilerPlugins`

传给 `compiler-core` 的插件：

```ts
const statsPlugin: CompilerPlugin = {
  name: 'stats',
  afterAnalyzeComponent(component) {
    console.log(component.name, component.signals.length);
  },
};

laniaFcVitePlugin({
  compilerPlugins: [statsPlugin],
});
```

执行阶段见 [编译期 API](/api/compile-time#compilerplugin)。

### `tsxInclude` / `tsxExclude`

默认：

```ts
tsxInclude: /\.lania\.tsx$/;
tsxExclude: undefined;
```

只处理匹配 `include` 且不匹配 `exclude` 的文件。

```ts
laniaFcVitePlugin({
  tsxInclude: /\.lania\.tsx$/,
  tsxExclude: /node_modules/,
});
```

### `debug`

只在 `vite dev` 下生效：

- 输出编译分组日志；
- 注入 `globalThis.__laniaCompile`；
- 不进入生产构建。

```ts
laniaFcVitePlugin({ debug: true });
```

控制台：

```text
[lania-v] compile: LoginPage
  TSX / FC
  Component IR
  renderPlan
  Generated module
```

`__laniaCompile`：

```js
__laniaCompile.LoginPage.fileName;
__laniaCompile.LoginPage.source;
__laniaCompile.LoginPage.component;
__laniaCompile.LoginPage.ir;
__laniaCompile.LoginPage.renderPlan;
__laniaCompile.LoginPage.moduleCode;
```

这些是编译期快照，不会在运行时被改写。

### `hotReload`

默认在 `vite dev` 下开启。

开启时：

- setup 字段初始化被收进 `__laniaSetup()`；
- HMR 换实现时可以按字段名重建 signal / computed / 本地绑定；
- 新增 setup 状态无需刷新页面。

关闭时：

- 模板与逻辑仍能热替换；
- 新增 setup 状态需要刷新页面。

```ts
laniaFcVitePlugin({ hotReload: false });
```

## 入口

```ts
import { laniaFcVitePlugin, laniaVitePlugin } from '@lania-v/vite-plugin';

laniaFcVitePlugin(options?): Plugin
laniaVitePlugin(options?): Plugin // 旧名，行为相同
```

插件元信息：

```ts
{
  name: 'lania-fc-vite-plugin',
  enforce: 'pre',
}
```

## 处理流程

```text
Vite transform(id, code)
  → createFilter(tsxInclude, tsxExclude)
  → compileFunctionComponentTsxModule(fileName, code, options)
  → TypeScript transpileModule（ES2022 / ESNext / ReactJSX）
  → 生成 sourcemap
  → 开发态追加 HMR import + accept
  → return { code, map }
```

### 为什么再做一次 TypeScript 转译

编译器输出的是“模块代码”，其中仍然包含 TypeScript 类型与 JSX。插件使用 `ts.transpileModule()`：

```ts
{
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  jsx: ts.JsxEmit.ReactJSX,
  jsxImportSource: '@lania-v/runtime',
  sourceMap: true,
  inlineSources: true,
  experimentalDecorators: true,
  useDefineForClassFields: false,
}
```

- 产出 Vite 能继续处理的 JS；
- 生成 sourcemap；
- 保持 `useDefineForClassFields: false`，与字段初始化语义一致。

### sourcemap

插件会对齐到原始 `.lania.tsx` 文件名：

```ts
map.sources = [fileName];
```

因此 Vite overlay 与浏览器调试会直接落在用户源码上。

## 编译失败

`LaniaTsxCompileError` 会被转换成 Vite 错误：

```ts
{
  id: fileName,
  message: error.message,
  frame: error.frame,
  loc: {
    file: error.fileName,
    line: error.line,
    column: error.column,
  },
}
```

Vite overlay 会显示：

- 文件名；
- 行 / 列；
- 源码帧；
- 原始错误消息。

## HMR

### 注入内容

开发态在模块末尾追加：

```ts
import { installComponentHmr as __laniaInstallComponentHmr } from '@lania-v/runtime';

if (import.meta.hot) {
  __laniaInstallComponentHmr();
  import.meta.hot.accept();
}
```

### `handleHotUpdate`

```ts
handleHotUpdate(ctx) {
  if (!filter(ctx.file)) return;
  return [...(ctx.server.moduleGraph.getModulesByFile(ctx.file) ?? [])];
}
```

插件不自行推断传播范围，交给 Vite 的 `moduleGraph`。

### 热替换语义

- 同名标签不重复 `define`；
- 新构造器替换已有实例原型；
- 已有实例重新挂载模板；
- 字段状态按名字保留；
- 新增 setup 字段需要 `hotReload: true`。

## 与 TypeScript 配合

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "@lania-v/runtime",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["vite/client"]
  }
}
```

还需要 `jsx.d.ts` 声明增强组件标签。见 [快速开始](/guide/getting-started)。

## 与其它框架共存

插件只处理 `.lania.tsx`，因此可以：

- React 渲染页面外壳；
- `.lania.tsx` 渲染自定义元素组件；
- 原生 DOM 挂载 lania-v 组件。

但 JSX 运行时只能有一个 `jsxImportSource`。混合项目建议：

- 为 React 文件加 `/** @jsxImportSource react */`；
- 或拆分独立入口 / 构建目标；
- 不要让同一个文件同时承担两套 JSX 语义。

## 常见问题

### 组件标签没有注册

```tsx
import Counter from './Counter.lania.tsx';

<Counter />;
```

默认导出是组件构造器。除非文件里有具名导出，否则不要写成：

```tsx
import { Counter } from './Counter.lania.tsx';
```

### `.lania.tsx` 没有被编译

检查：

- 文件名是否以 `.lania.tsx` 结尾；
- `tsxInclude` 是否匹配；
- 是否被 `tsxExclude` 排除；
- 插件是否排在其它 TS/JSX 插件之前。

### 开发态样式重复

DSD / SSR 与客户端都会注入样式。运行时用 `registerAppliedStyleTexts()` 去重；自定义注入逻辑需要自行登记。

### HMR 后状态丢失

检查：

- 是否关闭了 `hotReload`；
- 新字段是否是在 HMR 后新增的；
- 组件标签名是否变化。
