# 包与导出入口

这一页说明每个包负责什么、应该从哪里导入，以及不同入口的边界。

## 包结构

```text
packages/
├── shared/          跨包共享协议
├── compiler-core/   协议无关编译核心
├── compiler-tsx/    .lania.tsx 编译入口
├── runtime/         运行时核心（响应式 + 组件宿主 + DOM）
├── advanced/        增强组件（When / Each / KeepAlive / Transition …）
├── store/           原子化状态管理
└── vite-plugin/     Vite 集成
```

## `@lania-v/runtime`

运行时核心。业务代码通常只需要根入口。

### 子路径

| 子路径                                  | 内容                                        | 典型用途     |
| --------------------------------------- | ------------------------------------------- | ------------ |
| `@lania-v/runtime`                      | 全部公共运行时 API                          | 业务代码     |
| `@lania-v/runtime/dev`                  | 强制开启调试                                | 开发 / 测试  |
| `@lania-v/runtime/prod`                 | 强制关闭调试                                | 生产验证     |
| `@lania-v/runtime/core`                 | Context / Debug / Env / UniqueId            | 上下文、调试 |
| `@lania-v/runtime/reactivity`           | Signal / Scheduler / Resource / Selector    | 响应式       |
| `@lania-v/runtime/component`            | 组件宿主 / 样式 / 事件 / 渲染值类型         | 组件层       |
| `@lania-v/runtime/dom`                  | Slot / Updater / 指令 / class / style / ref | DOM 绑定     |
| `@lania-v/runtime/render`               | DOM 渲染 / SSR / DSD / Hydration            | 渲染与 SSR   |
| `@lania-v/runtime/jsx-runtime`          | JSX 运行时与类型                            | 类型声明     |
| `@lania-v/runtime/component/transition` | Transition 宿主与注册表                     | 增强组件基建 |
| `@lania-v/runtime/component/lifecycle`  | Boundary / KeepAlive 注册表                 | 增强组件基建 |
| `@lania-v/runtime/advanced`             | 信号追踪 / devtools overlay                 | 高级调试     |
| `@lania-v/runtime/internal`             | 内部辅助入口                                | 集成层       |
| `@lania-v/runtime/testing`              | 测试状态重置                                | 单元测试     |

### 根入口

```ts
export * from '@lania-v/shared';

export * from './core';
export * from './component';
export * from './dom/class-value';
export * from './dom/directives';
export * from './dom/html-value';
export * from './dom/ref';
export * from './dom/slot-pool';
export * from './dom/slot-table';
export * from './dom/slots';
export * from './dom/style-value';
export * from './dom/updaters';
export * from './reactivity/owner';
export * from './reactivity/resource';
export * from './reactivity/scheduler';
export * from './reactivity/selector';
export * from './reactivity/transition';
export * from './render';
export * from './dev/hmr';
```

根入口还包括 `createSignal` / `createMemo` / `createEffect` / `watch` 等显式 re-export。

`createStore` / `produce` 已移除；对象型状态请使用 `@lania/store` 的 `createAtom()`。

### 为什么有 `dev` / `prod`

```ts
import '@lania-v/runtime/dev'; // setDevEnvironmentOverride(true)
import '@lania-v/runtime/prod'; // setDevEnvironmentOverride(false)
```

打包器可能无法可靠注入 `__DEV__`。这两个入口用于：

- 测试环境强制开启调试事件；
- 生产构建强制关闭调试；
- 排除环境判断带来的不确定性。

`package.json` 也提供条件导出：

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "development": "./dist/entry/index.dev.js",
      "production": "./dist/entry/index.prod.js",
      "import": "./dist/index.js"
    }
  }
}
```

### `core`

```ts
import {
  createContext,
  provideContext,
  isDevEnvironment,
  warning,
  assert,
  createUniqueId,
} from '@lania-v/runtime/core';
```

包含：

- Context；
- 调试 hooks；
- 环境判断；
- 唯一 ID。

### `reactivity`

```ts
import {
  createSignal,
  createMemo,
  createEffect,
  createResource,
  createSelector,
  defaultScheduler,
} from '@lania-v/runtime/reactivity';
```

不包含组件与 DOM。

### `component`

```ts
import {
  defineComponent,
  createRoot,
  bindSlots,
  ReactiveElement,
  css,
} from '@lania-v/runtime/component';
```

包含：

- 组件宿主；
- 事件系统；
- 样式工具；
- 渲染值类型契约（`EnhancedRenderable` 等）。

增强组件（`When` / `Each` / `Suspense` / `KeepAlive` / `Transition`）已拆分到 `@lania-v/advanced`。

### `dom`

```ts
import {
  TextSlot,
  SlotTable,
  SimpleUpdater,
  registerDirective,
  createRef,
} from '@lania-v/runtime/dom';
```

适合编写自定义 Slot / Updater 或指令。

### `render`

```ts
import {
  renderToString,
  renderToStringWithDeclarativeShadow,
  hydrateIslands,
} from '@lania-v/runtime/render';
```

### `jsx-runtime`

```ts
import {
  jsx,
  jsxs,
  jsxDEV,
  Fragment,
  type LaniaJsxElement,
  type LaniaIntrinsicElementProps,
  type LaniaNativeIntrinsicElements,
  type LaniaEnhancedIntrinsicElements,
  type LaniaEventProps,
} from '@lania-v/runtime/jsx-runtime';
```

`jsx` / `jsxs` 直接返回可渲染值，不创建 VNode。

类型导出用于 `jsx.d.ts`：

```ts
declare namespace JSX {
  type Element = import('@lania-v/runtime/jsx-runtime').LaniaJsxElement;

  interface IntrinsicElements
    extends import('@lania-v/runtime/jsx-runtime').LaniaNativeIntrinsicElements,
      import('@lania-v/runtime/jsx-runtime').LaniaEnhancedIntrinsicElements {}
}
```

### `advanced`

```ts
import {
  isTracking,
  trackSignals,
  linkTrackedSignals,
  installDevtoolsOverlay,
} from '@lania-v/runtime/advanced';
```

### `internal`

```ts
import {
  createBoundaryHost,
  createErrorBoundaryHost,
  createSuspenseBoundaryHost,
  withRuntimeScope,
  withContextHost,
  withDomHost,
} from '@lania-v/runtime/internal';
```

供编译器产物与高级集成使用，不保证跨版本稳定。

### `testing`

```ts
import { resetRuntimeTestState } from '@lania-v/runtime/testing';

afterEach(() => resetRuntimeTestState());
```

清空：

- 指令注册表；
- KeepAlive slot 缓存；
- Boundary 状态；
- Transition 注册表。

## `@lania-v/advanced`

增强组件包。`When` / `Each` / `Switch` / `Suspense` / `KeepAlive` / `Transition` 等都从这里导入。

```tsx
import { Each, KeepAlive, Suspense, Transition, When } from '@lania-v/advanced';
```

依赖 `@lania-v/runtime`，并把自身构造器注册到 runtime 的动态 slot 中，因此：

- 使用增强组件时，请确保模块里 import 了 `@lania-v/advanced`；
- runtime 本身不再携带这些组件，核心包体积更小；
- SSR 的 `ssrRenderEnhancedBoundary` 等底层能力仍留在 runtime。

## `@lania/store`

原子化状态管理。

```ts
import {
  createAtom,
  createDerivedAtom,
  createAction,
  createAtomFamily,
  createStore,
  runWithStore,
  bindStore,
  persist,
  withHistory,
  withDevtools,
} from '@lania/store';
```

| API                                         | 作用                                                   |
| ------------------------------------------- | ------------------------------------------------------ |
| `createAtom(value, options?)`               | 可读写原子，`.value` 读、`.set()` 写（支持链式与路径） |
| `createDerivedAtom(read, write?)`           | 派生原子，读函数自动收集依赖                           |
| `createAction(fn)`                          | 批量写入的动作                                         |
| `createAtomFamily(key => atom)`             | 按 key 缓存原子                                        |
| `createStore()`                             | 独立作用域                                             |
| `runWithStore(store, fn)` / `bindStore(fn)` | 在指定作用域内读写（同步 / 异步）                      |
| `persist(atom, options)`                    | 持久化中间件                                           |
| `withHistory(atom)`                         | undo / redo                                            |
| `withDevtools(options)`                     | 调试快照                                               |

`@lania/store/internal` 只暴露编译器产物使用的 `getAtomDependency`，不面向业务代码。

## `@lania-v/shared`

编译器与运行时共享的稳定契约。

```ts
import {
  LANIA_VERSION,
  ENHANCED_COMPONENT_NAMES,
  ENHANCED_COMPONENT_REGISTRY,
  ENHANCED_COMPONENT_REGISTRY_LIST,
  ENHANCED_CONTRACT_PROTOCOL,
  ENHANCED_CONTRACT_VERSION,
  getEnhancedComponentRegistryEntry,
  getRequiredEnhancedParentComponentName,
  isEnhancedComponentName,
} from '@lania-v/shared';
```

| 导出                               | 说明               |
| ---------------------------------- | ------------------ |
| `LANIA_VERSION`                    | 版本常量           |
| `ENHANCED_COMPONENT_NAMES`         | 所有增强组件名     |
| `ENHANCED_COMPONENT_REGISTRY`      | 注册表对象         |
| `ENHANCED_COMPONENT_REGISTRY_LIST` | 注册表列表         |
| `ENHANCED_CONTRACT_PROTOCOL`       | `'lania.enhanced'` |
| `ENHANCED_CONTRACT_VERSION`        | `'0.1-draft'`      |

## `@lania-v/compiler-core`

协议无关的编译核心。

```ts
import {
  runComponentCompilerPipeline,
  createCompilerCore,
  generateComponentRenderCode,
  generateSSRCode,
  lowerProgramToComponentIR,
  analyzeComponentDependencies,
  allocateComponentSlots,
  generateComponentUpdaters,
  type ComponentIR,
  type CompilerPlugin,
  type CompilerPluginOptions,
  type CompilerProgram,
} from '@lania-v/compiler-core';
```

### 目录职责

| 目录          | 职责                                         |
| ------------- | -------------------------------------------- |
| `ast`         | 统一 AST                                     |
| `ir`          | Component IR、模板 lowering、render bindings |
| `analysis`    | 依赖分析、跨组件分析                         |
| `plan`        | Slot 分配、Updater 生成                      |
| `codegen`     | Render / SSR 代码生成                        |
| `transform`   | 模板与表达式优化                             |
| `diagnostics` | 源码定位                                     |
| `pipeline`    | 管线与插件                                   |

## `@lania-v/compiler-tsx`

`.lania.tsx` 编译入口。

```ts
import {
  compileFunctionComponentTsx,
  compileFunctionComponentTsxToModule,
  compileFunctionComponentTsxModule,
  emitFunctionComponentTsxModule,
  createCompiledTsxModuleMap,
  createTsxCompiler,
  parseFunctionComponentTsx,
  analyzeTsxBindingName,
  type CompiledTsxFunctionComponent,
  type CompiledTsxModule,
  type TsxTemplateSyntaxMode,
} from '@lania-v/compiler-tsx';
```

### 目录职责

| 目录       | 职责                       |
| ---------- | -------------------------- |
| `syntax`   | TSX 预处理与绑定语法归一化 |
| `parse`    | 函数组件、模板、表达式解析 |
| `analysis` | 绑定名分类                 |
| `compile`  | 编译入口与模块输出         |

## `@lania-v/vite-plugin`

```ts
import { laniaFcVitePlugin, laniaVitePlugin } from '@lania-v/vite-plugin';
```

详见 [Vite 插件](/api/plugin)。

## 依赖关系

```text
@lania-v/vite-plugin
  ├── @lania-v/compiler-tsx
  │     ├── @lania-v/compiler-core
  │     │     └── @lania-v/shared
  │     └── @lania-v/shared
  └── @lania-v/runtime
        └── @lania-v/shared
```

运行时**不依赖编译器**。编译产物的运行依赖只有：

- `@lania-v/runtime`
- `@lania-v/shared`

## tree-shaking 与 sideEffects

`package.json` 中：

```json
{
  "sideEffects": false
}
```

例外：

```json
{
  "sideEffects": ["./dist/entry/index.dev.js", "./dist/entry/index.prod.js"]
}
```

因为这两个入口在导入时设置开发环境覆盖。

业务构建通常只需要：

```ts
import { createSignal, defineComponent } from '@lania-v/runtime';
```

## 版本

```ts
import { LANIA_VERSION } from '@lania-v/shared';

LANIA_VERSION; // '0.0.0'
```

所有包版本由 changesets 统一管理。
