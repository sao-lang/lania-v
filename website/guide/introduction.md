# 为什么是 lania-v

`lania-v` 是一个**编译优先**的细粒度 Web Components 框架。它把组件源码（`.lania.tsx`）编译成可执行的渲染计划，再用 Signal 驱动精确的 DOM 更新。

它明确拒绝两件事：

- 用 Virtual DOM 表达组件树；
- 在每次更新时对整棵树做 Diff。

## 一个组件要回答的三个问题

传统运行时框架通常在更新时回答：

1. 哪个状态变了？
2. 哪些组件需要重新执行？
3. 新旧树哪里不同？

`lania-v` 选择在**编译期**把前两个问题回答掉：

| 问题 | 回答者 | 产物 |
| --- | --- | --- |
| 哪个表达式依赖哪个 Signal？ | 编译器依赖分析 | `dependencyAnalysis` |
| 表达式写进哪个 DOM 位置？ | Slot 分配 | `slotAllocation` |
| 什么时候执行、一次写几个位置？ | Updater 规划 | `updaterGeneration` |
| 运行时怎么更新？ | Scheduler + Slot | DOM 写入 |

于是运行时只剩一条链路：

```text
Signal.set
  → Scheduler
  → Updater.run
  → Slot.write
  → DOM
```

## 分层架构

```text
Authoring      FC / TSX（.lania.tsx）
Compiler       Parse → AST → Component IR → Dependency Analysis
               → renderPlan → Codegen
Runtime        ReactiveElement → Signal / Computed / Effect
               → Scheduler → Updater → Slot → DOM
Integration    Vite Plugin / HMR / Devtools / SSR
```

这些职责被拆到不同的包中：

| 包 | 职责 |
| --- | --- |
| `@lania-v/shared` | 编译器与运行时共享的协议、增强组件注册表、版本常量 |
| `@lania-v/compiler-core` | 协议无关的编译核心：AST、IR、依赖分析、Slot/Updater 规划、代码生成 |
| `@lania-v/compiler-tsx` | `.lania.tsx` 的解析、函数组件分析与模块输出 |
| `@lania-v/runtime` | Signal、Scheduler、Slot、Updater、组件宿主、增强组件、SSR |
| `@lania-v/vite-plugin` | Vite 接入：文件过滤、编译调用、错误桥接、HMR |

## 关键设计选择

### 1. 编译期决定依赖，运行期不做依赖追踪

`createMemo` / `createEffect` 在普通运行时场景仍会动态收集依赖；但在 `.lania.tsx` 的编译产物里，模板绑定的依赖会由编译器静态写入 Updater。

这让模板更新不必在每次执行时重新收集依赖，也不必为整棵组件树建立 VNode。

### 2. Slot 是更新粒度

一个 Slot 代表一个可写位置，例如：

- 一个文本节点；
- 一个 attribute；
- 一个 class / style 字符串；
- 一个条件分支；
- 一个列表；
- 一个组件属性。

Updater 只写入自己负责的 Slot。Slot 内部再做一次等值判断，避免无意义的 DOM 写入。

### 3. 组件就是 Custom Element

每个 `.lania.tsx` 组件最终都会生成一个继承 `ReactiveElement` 的类，并注册为自定义元素。因此：

- 组件可以独立分发；
- 可以放在任何 HTML 页面里；
- 可以和 React、Vue、原生脚本混用；
- 天然拥有 Shadow DOM、`adoptedStyleSheets`、`ElementInternals` 等平台能力。

### 4. 增强组件是编译期协议，不是普通组件

`When`、`Each`、`Switch`、`Teleport`、`KeepAlive`、`Transition`、`Suspense` 等标签并不是普通的函数组件。编译器会识别它们，并下沉为对应的 IR：

| 标签 | IR |
| --- | --- |
| `When` / `Switch` | `IfIR` |
| `Each` | `ListIR` |
| `Dynamic` / `Slot` / `Await` / `Virtual` | `DynamicIR` |
| `Teleport` | `TeleportIR` |
| `KeepAlive` | `KeepAliveIR` |
| `Transition` / `TransitionGroup` | `TransitionIR` |
| `Suspense` / `ErrorBoundary` / `LazyLoad` | `BoundaryIR` |
| `Then` / `Else` / `Case` / `Default` / `Fragment` | `passthrough`（语法节点） |

## 和常见框架的差异

| 维度 | lania-v | React | Vue 3 | Solid |
| --- | --- | --- | --- | --- |
| 更新模型 | 编译期依赖 + Slot 精确写入 | VDOM Diff / Fiber | 响应式 + VDOM Diff | 响应式 + 编译期绑定 |
| 组件形态 | Custom Element | 函数组件 | SFC / 组件对象 | 函数组件 |
| 模板来源 | TSX | JSX | Template | JSX |
| 运行时不执行组件函数做 Diff | 是 | 否 | 否 | 是 |
| 原生 Web Components | 一等公民 | 需包装 | 需包装 | 需包装 |
| 编译产物 | Component IR + renderPlan | 无 | 编译模板 | 编译 JSX |

`lania-v` 与 Solid 的相似点是都依赖细粒度响应式；不同点在于组件最终落在 Custom Element 上，并且把结构语义（条件、列表、增强组件）显式建模进 `renderPlan`。

## 适合与不适合

适合：

- 需要把组件分发为原生自定义元素的场景；
- 对更新粒度和可预测性有要求的 UI；
- 希望编译期尽可能多做事、运行期尽可能少做事的项目；
- 需要在同一个页面里与其它框架共存的组件库。

暂时不适合：

- 依赖完整 React 生态（如 React Server Components、第三方 Hooks）的项目；
- 需要成熟表单/路由/状态管理全家桶、且不愿自行封装的项目；
- 大量依赖运行时动态模板字符串的场景。

## 下一步

- [快速开始](/guide/getting-started)：把最小项目跑起来。
- [编译模型](/guide/compilation-model)：理解 TSX 如何变成 renderPlan。
- [响应式基础](/guide/reactivity)：掌握 Signal、Memo、Effect、Scheduler。
