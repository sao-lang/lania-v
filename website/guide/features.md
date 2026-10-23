# 特性总览

这一页是能力的总目录：按 **编译期 / 运行时 / 模板 / 组件 / 增强组件 / SSR / 工程化** 七组，列出 lania-v 当前已经实现的能力，并给出对应文档入口。

想先了解「为什么这样设计」，请读 [为什么是 lania-v](/guide/introduction)；想直接跑起来，请读 [快速开始](/guide/getting-started)。

## 能力地图

| 分组                  | 一句话                                                   |
| --------------------- | -------------------------------------------------------- |
| [编译期](#编译期)     | 把 `.lania.tsx` 变成 Component IR、renderPlan 和模块代码 |
| [运行时](#运行时)     | Signal 驱动的细粒度更新，没有 VNode，也没有整树 Diff     |
| [模板](#模板与绑定)   | 标准 JSX 属性 + 对象形式的绑定协议                       |
| [组件](#组件模型)     | 每个组件都是一个 Custom Element，继承 `ReactiveElement`  |
| [增强组件](#增强组件) | 条件、列表、Teleport、KeepAlive、过渡、边界等结构化能力  |
| [SSR](#ssr)           | 字符串 / 流式渲染、DSD、Islands 与部分水合               |
| [工程化](#工程化)     | Vite 插件、HMR、编译快照、调试钩子、测试辅助             |

## 编译期

| 能力         | 说明                                                                | 文档                                                     |
| ------------ | ------------------------------------------------------------------- | -------------------------------------------------------- |
| TSX 预处理   | 识别并拆分扩展绑定名，产出可被 TypeScript 解析的源码                | [编译管线](/advanced/compiler-pipeline#_1-tsx-预处理)    |
| Component IR | 组件声明的统一中间表示：props、signals、computed、effects、template | [编译模型](/guide/compilation-model#_2-component-ir)     |
| 依赖分析     | 表达式级分析：模板读了哪些 Signal、Store 的哪些稳定路径             | [依赖分析](/guide/compilation-model#_3-依赖分析)         |
| Slot 分配    | 为每个可写位置分配运行时更新槽                                      | [Slot 分配](/guide/compilation-model#_4-slot-分配)       |
| Updater 规划 | 生成「值变化 → 写哪个 Slot」的更新器                                | [Updater 规划](/guide/compilation-model#_5-updater-规划) |
| Render Plan  | 运行时执行的最终计划，包含绑定表与优先级                            | [renderPlan](/guide/compilation-model#_6-renderplan)     |
| 模板优化     | 静态提升、常量折叠、可静态化表达式消除                              | [模板优化](/advanced/compiler-pipeline#_6-模板优化)      |
| 代码生成     | 生成继承 `ReactiveElement` 的组件类与 SSR 方法                      | [代码生成](/advanced/compiler-pipeline#_11-代码生成)     |
| 诊断         | `LaniaTsxCompileError`：文件、行、列、源码帧                        | [诊断](/advanced/compiler-pipeline#_14-诊断)             |
| 插件钩子     | `CompilerPlugin`：在分析、IR、代码生成阶段插入逻辑                  | [编译期 API](/api/compile-time)                          |

编译只发生在构建链路里：浏览器拿到的是普通模块代码，不包含编译器。

## 运行时

| 能力                       | 说明                                                    | 文档                                                         |
| -------------------------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| `createSignal()`           | 最小响应式单元，带等值判断与 updater 订阅表             | [响应式 API](/api/reactivity#signal)                         |
| `createMemo()`             | 派生值，惰性求值，依赖变化才重算                        | [响应式 API](/api/reactivity#memo)                           |
| `createEffect()`           | 副作用，由调度器按队列执行                              | [响应式 API](/api/reactivity#effect)                         |
| `watch()`                  | 监听单个或多个 source，回调拿到新旧值                   | [响应式基础](/guide/reactivity#watch)                        |
| `readonly()` / `untrack()` | 只读视图与脱轨读取                                      | [响应式基础](/guide/reactivity)                              |
| `createDeferred()`         | 延迟值，用于把昂贵渲染让给下一帧                        | [响应式基础](/guide/reactivity)                              |
| Scheduler                  | 分优先级队列、微任务 flush、批处理、`tick()`            | [更新链路](/advanced/update-pipeline)                        |
| `startTransition()`        | 低优先级更新，可被打断                                  | [响应式基础](/guide/reactivity#低优先级更新-starttransition) |
| `createAtom()`             | 基于 Signal 的原子状态，支持路径级订阅                  | [状态管理](/guide/state)                                     |
| `createDerivedAtom()`      | 由其他 atom 派生的只读/可写原子                         | [状态管理](/guide/state)                                     |
| `createAction()`           | 把一组写入合并成一次提交                                | [状态管理](/guide/state)                                     |
| `watch()` getter 源        | 按路径观察 atom 变化                                    | [状态管理](/guide/state)                                     |
| `createSelector()`         | 从列表里选出单个匹配项，避免全量失效                    | [状态管理](/guide/state#createselector)                      |
| `createResource()`         | 异步数据源，带 pending / error / refetch                | [异步与边界](/guide/async-and-boundaries#createresource)     |
| Owner / Scope              | 作用域清理，组件卸载时统一释放 effect                   | [响应式 API](/api/reactivity#owner-scope)                    |
| Context                    | `createContext()` / `provideContext()` / `useContext()` | [上下文](/guide/context)                                     |

## 模板与绑定

| 能力                  | 写法                                                                                                   | 文档                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| 文本插值              | `{value()}`                                                                                            | [模板与绑定](/guide/templates#文本与子节点)     |
| 静态 / 动态属性       | `id="a"`、`value={v()}`                                                                                | [模板与绑定](/guide/templates#属性与-property)  |
| `class` / `className` | 字符串、数组、对象                                                                                     | [模板与绑定](/guide/templates#class-classname)  |
| `style`               | 字符串、对象、CSS 变量                                                                                 | [模板与绑定](/guide/templates#style)            |
| 原始 HTML             | `html={htmlString()}`                                                                                  | [模板与绑定](/guide/templates#原始-html)        |
| 事件                  | `onClick={fn}`、`onClick={ { handler, modifiers } }`                                                   | [模板与绑定](/guide/templates#事件)             |
| 事件修饰符            | `stop` / `prevent` / `self` / `immediate` / `passive` / `left`·`middle`·`right` / `key:*` / `system:*` | [模板与绑定](/guide/templates#对象写法与修饰符) |
| 事件委托              | `enableEventDelegation(root)`                                                                          | [模板与绑定](/guide/templates#事件委托)         |
| 双向绑定              | `model={ { target, prop, modifiers } }`                                                                | [模板与绑定](/guide/templates#双向绑定-model)   |
| 元素引用              | `ref={ref}`、函数 ref                                                                                  | [模板与绑定](/guide/templates#ref)              |
| 自定义指令            | `use={ { name: value } }` + `registerDirective()`                                                      | [模板与绑定](/guide/templates#自定义指令)       |
| 条件与列表            | `<When>`、`<Each>`、`<Switch>`                                                                         | [条件与列表](/guide/control-flow)               |

完整的属性清单、表达式规则与语法模式对照见 [语法参考](/guide/syntax)。

## 组件模型

| 能力                           | 说明                                                                     | 文档                                                |
| ------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------- |
| `defineComponent(fn, options)` | 把函数组件编译为 Custom Element 类                                       | [组件 API](/api/component#定义组件)                 |
| Prop 选项                      | `type` / `attribute` / `reflect` / `default` / `converter` / `validator` | [组件](/guide/components#prop-选项)                 |
| 事件声明                       | `emits: ['select']`，开发态校验未声明事件                                | [组件](/guide/components#事件声明)                  |
| 生命周期                       | `onMount()` / `onUpdated(changedProps)` / `onCleanup()`                  | [组件](/guide/components#生命周期)                  |
| 派发事件                       | `this.emit(name, detail)`                                                | [组件](/guide/components#派发事件)                  |
| 插槽                           | `props.children`、`bindSlots()`、具名槽、作用域槽                        | [插槽](/guide/slots)                                |
| 对外暴露                       | `createExpose()`，父组件用 `ref` 拿到公开面                              | [组件](/guide/components#createexpose)              |
| 属性 / 回调分流                | `bindProps()` / `bindHandlers()`                                         | [组件](/guide/components#bindprops-与-bindhandlers) |
| 样式                           | `` css`...` `` + `Component.styles`，注入 Shadow Root                    | [组件](/guide/components#样式)                      |
| 渲染模式                       | `static renderMode = 'shadow' \| 'light'`                                | [组件](/guide/components#渲染模式)                  |
| 表单关联                       | `ElementInternals` 表单参与                                              | [组件](/guide/components#表单关联)                  |
| 懒加载                         | `lazy(() => import('./X.lania.tsx'))`                                    | [异步与边界](/guide/async-and-boundaries#lazy)      |
| HMR                            | 同名标签重注册走原型替换，字段状态按名保留                               | [开发与调试](/guide/dev-and-debug#hmr)              |

## 增强组件

增强组件不是普通函数组件：编译器会把它们下沉成专门的 IR 节点，运行时按渲染计划执行。

它们位于 `@lania-v/runtime/advanced` 二级入口，使用前需要显式导入：

```ts
import {
  Each,
  KeepAlive,
  Suspense,
  Transition,
  When,
} from '@lania-v/runtime/advanced';
```

| 组件                                      | 作用                                            | 文档                                                |
| ----------------------------------------- | ----------------------------------------------- | --------------------------------------------------- |
| `When`                                    | 条件渲染，支持 `fallback`                       | [API](/api/enhanced-components#when)                |
| `Switch` / `Case` / `Default`             | 多分支                                          | [API](/api/enhanced-components#switch-case-default) |
| `Each`                                    | 带 key 的列表，支持 `fallback`                  | [API](/api/enhanced-components#each)                |
| `Dynamic`                                 | 按值切换组件或标签                              | [API](/api/enhanced-components#dynamic)             |
| `Slot`                                    | 插槽占位（运行时 JSX 路径）                     | [API](/api/enhanced-components#slot)                |
| `Fragment`                                | 多根节点分组                                    | [API](/api/enhanced-components#fragment)            |
| `Teleport`                                | 把内容渲染到指定容器                            | [API](/api/enhanced-components#teleport)            |
| `KeepAlive`                               | 缓存子树状态                                    | [API](/api/enhanced-components#keepalive)           |
| `Transition` / `TransitionGroup`          | 进入 / 离开过渡                                 | [API](/api/enhanced-components#transition)          |
| `Suspense` / `ErrorBoundary` / `LazyLoad` | 异步与错误边界                                  | [API](/api/enhanced-components#suspense)            |
| `Await`                                   | 轻量 Promise 渲染器（fallback / error / delay） | [API](/api/enhanced-components#await)               |
| `Virtual`                                 | 固定行高的窗口化列表                            | [API](/api/enhanced-components#virtual)             |

## SSR

| 能力                   | 入口                                           | 文档                                     |
| ---------------------- | ---------------------------------------------- | ---------------------------------------- |
| 字符串渲染             | `renderToString(Comp, props)`                  | [SSR](/guide/ssr#字符串渲染)             |
| 流式渲染               | `renderToStream(Comp, props)`                  | [SSR](/guide/ssr#字符串渲染)             |
| Declarative Shadow DOM | `renderToStringWithDeclarativeShadow()`        | [SSR](/guide/ssr#declarative-shadow-dom) |
| 流式 DSD               | `renderStreamToDeclarativeShadow()`            | [SSR](/guide/ssr#流式-dsd)               |
| Islands                | `renderIsland()` / `renderToStringAsIsland()`  | [SSR](/guide/ssr#部分水合-islands)       |
| 客户端水合             | `hydrateIslands()`、组件级 `hydration` 策略    | [SSR](/guide/ssr#部分水合-islands)       |
| 标记协议               | Slot / boundary / teleport / suspense 注释标记 | [SSR API](/api/ssr#marker-协议)          |

## 工程化

| 能力           | 入口                                                            | 文档                                              |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| Vite 插件      | `laniaFcVitePlugin(options)`                                    | [Vite 插件](/api/plugin)                          |
| 文件过滤       | `tsxInclude` / `tsxExclude`                                     | [Vite 插件](/api/plugin#tsxinclude-tsxexclude)    |
| 语法模式       | `tsxTemplateSyntaxMode: 'jsx-standard' \| 'directive-extended'` | [语法参考](/guide/syntax#两种语法模式)            |
| 编译快照       | `debug: true` + `globalThis.__laniaCompile`                     | [开发与调试](/guide/dev-and-debug#编译快照)       |
| 运行时调试钩子 | `registerRuntimeDebugHooks()`                                   | [开发与调试](/guide/dev-and-debug#运行时调试钩子) |
| 更新高亮       | devtools overlay                                                | [开发与调试](/guide/dev-and-debug#更新高亮)       |
| 测试辅助       | `resetRuntimeTestState()`                                       | [包与导出入口](/api/packages)                     |
| 环境覆盖       | `@lania-v/runtime/dev` / `@lania-v/runtime/prod`                | [工程配置](/guide/configuration#环境与调试开关)   |

## 内置、需自行集成、明确不做

| 类别       | 内容                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------- |
| 内置       | 响应式、渲染、组件、增强组件、SSR / DSD / Islands、Vite 集成                                |
| 需自行集成 | 路由、国际化、HTTP 客户端、表单校验库、UI 组件库                                            |
| 明确不做   | Virtual DOM 与整树 Diff；运行时模板字符串编译；SFC 单文件组件；以组件函数重执行作为更新手段 |

::: tip 为什么没有路由
组件最终是 Custom Element，路由属于「页面级编排」，不同宿主（MPA、SSR、微前端）差异很大。lania-v 不把路由塞进核心，避免约束宿主形态。
:::

## 建议的阅读路径

1. **先跑通**：[快速开始](/guide/getting-started) → [编译模型](/guide/compilation-model)
2. **写业务**：[响应式基础](/guide/reactivity) → [语法参考](/guide/syntax) → [组件](/guide/components)
3. **做工程**：[工程配置](/guide/configuration) → [构建与部署](/guide/build-and-deploy)
4. **查细节**：[API 参考](/api/) 与 [深入实现](/advanced/architecture)
