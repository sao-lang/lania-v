# API 总览

这一部分是**查阅型文档**。和指南不同，它按 API 组织，重点说明：

- 这个 API 解决什么问题；
- 参数和返回值的含义；
- 运行时语义与执行时机；
- 常见误用与边界；
- 和相邻 API 的区别。

## 从哪里导入

```ts
// 运行时主入口：绝大多数业务代码只需要它
import { createSignal, defineComponent } from '@lania-v/runtime';

// 高级调试入口
import { trackSignals, installDevtoolsOverlay } from '@lania-v/runtime/advanced';

// 测试辅助
import { resetRuntimeTestState } from '@lania-v/runtime/testing';

// 编译器
import { compileFunctionComponentTsxModule } from '@lania-v/compiler-tsx';
import { runComponentCompilerPipeline } from '@lania-v/compiler-core';

// 跨包共享协议
import { ENHANCED_COMPONENT_NAMES } from '@lania-v/shared';
```

完整的子路径列表见 [包与导出入口](/api/packages)。

## 文档约定

| 记号 | 含义 |
| --- | --- |
| `T` | 泛型参数 |
| `?` | 可选参数 |
| `ReadonlySignal<T>` | 可调用、可 `peek()`，但没有 `set` |
| `Scheduler` | 调度器实例，默认 `defaultScheduler` |
| `Job` | 一个无参函数，由调度器执行 |
| `EnhancedRenderable` | 可渲染值：`Node`、字符串、数字、布尔、`null`、数组、函数 |
| `compile-only` | 只在 `.lania.tsx` 编译链中有意义，运行时直接调用会抛错 |

## API 分区

| 分区 | 内容 |
| --- | --- |
| [响应式 API](/api/reactivity) | Signal、Memo、Effect、Scheduler、Store、Resource、Selector、Owner、Context |
| [组件 API](/api/component) | `defineComponent`、挂载、生命周期、slots、expose、表单、`ReactiveElement` |
| [DOM 与绑定 API](/api/dom) | class、style、html、model、ref、指令、Slot、Updater |
| [增强组件 API](/api/enhanced-components) | `When`、`Each`、`Teleport`、`KeepAlive`、`Transition`、`Suspense` 等 |
| [编译期 API](/api/compile-time) | compile-only 标记、编译器入口、插件 |
| [SSR API](/api/ssr) | 字符串渲染、DSD、Islands、水合 |
| [Vite 插件](/api/plugin) | 插件选项、transform、HMR、调试 |
| [包与导出入口](/api/packages) | 各包职责与子路径 |

## 三种 API

### 1. 纯运行时 API

可以在任何 JS/TS 环境调用：

```ts
const count = createSignal(0);
const double = createMemo(() => count() * 2);
```

### 2. 编译链 API

必须写在 `.lania.tsx` 中，由编译器改写：

```tsx
onMount(() => { /* ... */ });
provideContext(ThemeContext, theme);
useFormValue(() => account());
const inputRef = createRef<HTMLInputElement>();
```

### 3. 编辑器 / 类型 API

只影响类型推断，不产生运行时行为：

```ts
import type { LaniaJsxElement, LaniaNativeIntrinsicElements } from '@lania-v/runtime/jsx-runtime';
```

## 阅读顺序建议

- 第一次使用：先读 [快速开始](/guide/getting-started) 和 [响应式基础](/guide/reactivity)。
- 查单个函数：直接在本部分搜索。
- 查增强组件：先看 [条件与列表](/guide/control-flow)，再看 [增强组件 API](/api/enhanced-components)。
- 查编译器：先看 [编译模型](/guide/compilation-model)，再看 [编译期 API](/api/compile-time)。
