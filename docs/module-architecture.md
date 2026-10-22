<!-- markdownlint-disable MD013 -->

# 模块与链路总览

本文档面向“想一次看清整个仓库”的读者，目标只有两个：

1. 说明当前项目有哪些模块、每个模块负责什么。
2. 说明模块之间如何联动，以及几条核心链路是如何跑通的。

项目当前唯一主线仍然是：

```text
TSX / FC -> Component IR -> renderPlan -> Updater -> Slot -> DOM
```

如果 `technical-scheme.md` 负责定义方向，这份文档负责把方向拆成“模块视图 + 链路视图”。

## 1. 仓库全景

仓库采用 monorepo，根工作区只做装配、脚本和质量入口：

- `packages/*`：可复用、可发布的核心包
- `playground/*`：示例、人工验收和性能基准入口
- `tests/*`：自动化测试
- `docs/*`：架构、API、流程文档
- `scripts/*`：工程脚本，例如 benchmark 报告生成、ESM specifier 修补

根 `package.json` 统一提供这些工程链路入口：

- 开发：`npm run dev`
- 构建：`npm run build`
- 类型检查：`npm run typecheck`
- 单元测试：`npm run test`
- E2E：`npm run test:e2e`
- Benchmark：`npm run bench`
- 发布：`npm run release`

换句话说，根目录不承载框架逻辑，只负责把各个模块串起来。

## 2. 模块地图

| 模块                     | 主要职责                                                  | 上游输入                           | 下游输出                                           |
| ------------------------ | --------------------------------------------------------- | ---------------------------------- | -------------------------------------------------- |
| `packages/shared`        | 共享协议、增强组件注册表、跨包常量                        | 编译器和运行时共同约定             | 供 runtime / compiler / 集成层复用的契约           |
| `packages/compiler-core` | AST、IR、依赖分析、renderPlan、slot/updater 规划、codegen | 来自 `compiler-tsx` 的统一组件声明 | 编译产物、render code、SSR code、诊断结果          |
| `packages/compiler-tsx`  | `.lania.tsx` 解析、绑定分析、函数组件编译入口、模块封装   | TSX 源码                           | `compiler-core` 可消费的程序结构与最终 module code |
| `packages/vite-plugin`   | 将 `.lania.tsx` 编译接入 Vite transform / HMR             | 源文件、编译器插件配置             | 给 Vite 的 JS + sourcemap + 编译错误               |
| `packages/runtime`       | 响应式、调度、slot、组件宿主、增强组件、SSR/Hydration     | 编译产物、运行时 API 调用          | DOM、事件、副作用、SSR/Hydration 行为              |
| `playground/todo`        | 默认开发入口与功能验收                                    | runtime + compiler + vite-plugin   | 人工验证场景与 E2E 载体                            |
| `playground/compiler`    | 编译链路可视化                                            | `compiler-tsx` 编译结果            | AST / IR / dependency / render code 展示           |
| `playground/benchmark`   | 横向性能基准                                              | runtime + vite-plugin + 多框架实现 | benchmark 结果                                     |
| `tests`                  | 单元、集成、E2E、benchmark 自动化验证                     | 全部核心模块                       | 回归信号、验收证据                                 |
| `docs`                   | 主线、API、工程流程说明                                   | 当前实现与测试结论                 | 团队统一认知与维护基线                             |

## 3. 各模块的功能与边界

### 3.1 根工作区与工程层

根目录负责四件事：

1. 定义 workspace 边界，只承认 `packages/*` 和 `playground/*`
2. 提供统一脚本入口，避免每个包各自维护一套命令
3. 聚合 lint / typecheck / test / e2e / bench / release 流程
4. 承载工程辅助脚本与文档

它不负责：

- 运行时实现
- 编译逻辑
- Vite 插件逻辑
- playground 业务示例本身

### 3.2 `packages/shared`

这是全仓库的“公共契约层”，职责很集中：

- 定义增强组件注册表
- 定义增强组件 payload / contract 协议
- 暴露跨包常量，例如版本号

它的价值不在执行，而在统一语义来源。

编译器需要它来判断：

- 哪些增强组件是合法组件
- 不同增强组件属于什么类别
- 编译产物需要生成什么样的协议字段

运行时需要它来判断：

- 收到的 payload 应该按什么规则执行
- 不同 boundary、keepalive、transition 能力的字段含义是什么

因此，`shared` 是编译期和运行时之间的第一层通信面。

### 3.3 `packages/compiler-core`

这是编译核心，不关心输入是不是 TSX，也不直接处理 Vite。

内部主要分为几组子模块：

- `ast`：统一 AST 结构
- `ir`：`Component IR`、模板 lowering、render bindings
- `analysis`：依赖分析、cross-component 分析、store path 分析
- `transform`：模板优化、renderPlan 重建、表达式优化
- `plan`：slot 分配和 updater 生成
- `codegen`：render code、SSR code、类组件代码生成
- `diagnostics`：错误定位、源码片段、诊断信息
- `pipeline`：把上述阶段按固定顺序串起来

它的核心职责是把“结构化组件描述”变成“运行时可执行计划”。

它的核心输出不是单纯一段代码，而是一组互相关联的中间结果：

- `Component IR`
- `dependencyAnalysis`
- `renderPlan`
- `slotAllocation`
- `updaterGeneration`
- `renderCode`
- `classCode`

这些结果共同定义了编译后组件在运行时应该如何挂载、如何更新、如何做 SSR。

### 3.4 `packages/compiler-tsx`

这是 `.lania.tsx` 主路径的入口编译器。

它主要做四件事：

1. 解析函数组件源码
2. 建立 binding context，识别 props / signals / computed / lifecycle / template
3. 把 TSX authoring 写法收敛成 `compiler-core` 能理解的统一结构
4. 把 `compiler-core` 的产物包装成最终 ES module

内部子模块职责大致如下：

- `syntax`：TSX 预处理和绑定语法归一化
- `parse`：函数组件、模板、表达式和 binding 采集
- `analysis`：TSX 入口侧的轻量语义判断
- `compile`：编译入口、错误对象、模块输出

可以把它理解为“作者写法 -> 核心编译模型”之间的适配层。

### 3.5 `packages/vite-plugin`

这是集成层，不承担编译核心。

它只做下面这些事情：

- 过滤 `.lania.tsx` 文件
- 在 `transform` 阶段调用 `compiler-tsx`
- 把编译结果再交给 TypeScript 做一次 `transpileModule`
- 把编译错误转成 Vite overlay 可识别的错误对象
- 在 `handleHotUpdate` 中把模块图刷新回 Vite

它和 `compiler-core` / `compiler-tsx` 的关系是：

- 不重写编译流程
- 不解释编译产物
- 只负责把编译器接到开发工具链里

### 3.6 `packages/runtime`

这是最大的核心模块，也是编译产物最终落地的执行面。

它内部可以分成五层。

#### `core`

负责运行时基础能力：

- `context`
- `debug`
- `env`

这层主要提供运行时上下文和环境抽象，不直接做 DOM 更新。

#### `reactivity`

负责响应式与调度：

- `createSignal`
- `createMemo`
- `createEffect`
- `watch`
- `scheduler`
- `store`
- `resource`

它回答的是“数据变了以后，谁需要重新执行，执行顺序是什么”。

#### `dom`

负责把“更新动作”真正写入 DOM：

- 各种 `Slot`
- `slot-table`
- `slot-pool`
- DOM updaters
- `class` / `style` / `html` / `ref`
- 指令绑定

它回答的是“这一类动态内容在 DOM 上具体如何挂载和更新”。

#### `component`

负责组件宿主和高阶能力：

- `ReactiveElement`
- 函数组件宿主与 scope
- 事件系统
- 样式挂载
- boundary / keepalive / transition 等增强组件运行时

它回答的是“组件实例怎么存在、怎么拿到 host、怎么与生命周期和高阶能力协作”。

#### `render`

负责渲染入口与 SSR/Hydration：

- DOM 挂载
- 静态模板 mount
- hydration marker 扫描
- SSR slot / boundary 输出

它回答的是“模板第一次怎么落到页面上，以及服务端 HTML 怎么复用”。

#### `entry`

负责不同消费入口：

- `jsx-runtime`
- `jsx-dev-runtime`
- `advanced`
- `internal`
- `testing`
- `index.dev` / `index.prod`

它的作用是把同一套 runtime 能力暴露给不同上层，而不让调用方依赖深层路径。

### 3.7 `playground/*`

三个 playground 分工清楚。

#### `playground/todo`

这是默认开发入口，也是最重要的人工验收面。

它覆盖：

- 基础 FC 组合
- Todo 交互主流程
- `bindProps` / `bindHandlers` / `bindSlots` / `createExpose`
- 指令绑定
- 本地状态
- 增强组件组合

E2E 测试也是围绕它展开，所以它同时承担“示例 + 回归载体”。

#### `playground/compiler`

这是编译链路可视化工具。

它直接展示：

- 输入 TSX
- AST
- `Component IR`
- `dependencyAnalysis`
- `slotAllocation`
- `updaterGeneration`
- 生成的类组件代码
- 生成的 `_renderAndMount()`

它不是业务示例，而是编译器调试和架构理解入口。

#### `playground/benchmark`

这是性能基准入口。

它用同一套 benchmark harness 比较：

- `lania-v`
- `React`
- `Vue`
- `Solid`

当前覆盖：

- mount
- text update
- list patch
- toggle
- model input

它回答的问题不是“能不能用”，而是“更新链路成本如何”。

### 3.8 `tests`

测试层分成三类。

#### 单元 / 集成测试

`vitest` 直接测试源码，并通过 alias 指向 `packages/*/src`。

主要覆盖：

- compiler diagnostics / plugin / render codegen
- runtime signal / scheduler / slot / updater / render
- 函数组件、通信、样式、事件、指令
- shared registry / contract

#### E2E 链路

`playwright` 启动 `playground/todo`，验证真实浏览器交互链路。

它主要回答：

- 编译后的组件能不能在浏览器里正确运行
- 关键交互有没有回退

#### Benchmark 链路

`playwright` 驱动 `playground/benchmark`，收集批量样本并生成报告。

它主要回答：

- 不同框架在同一类操作下的成本差异是什么
- 当前 runtime / compiler 收敛后，更新路径是否稳定

### 3.9 `docs`

文档层不只是说明书，也是“认知边界”的维护层：

- `technical-scheme.md`：唯一架构入口
- `runtime-api.md`：运行时 API 与 FC 主路径
- `ssr-hydration.md`：SSR / Hydration 协议边界
- `module-architecture.md`：模块职责与链路总览
- `plan.md`：执行计划与验收清单
- `engineering-conventions.md` / `release.md` / `benchmark.md`：工程流程

## 4. 模块之间如何联动

项目里的模块通信主要有五类。

### 4.1 编译期结构通信

通信对象：

- `compiler-tsx`
- `compiler-core`

通信内容：

- 统一 AST / 组件声明
- `Component IR`
- `dependencyAnalysis`
- `renderPlan`
- slot / updater 规划结果

这类通信不直接碰 DOM，而是在不断收紧“组件应该如何执行”的计划。

### 4.2 契约通信

通信对象：

- `shared`
- `compiler-core`
- `compiler-tsx`
- `runtime`

通信内容：

- 增强组件注册表
- boundary / keepalive / suspense 等 payload 协议
- 运行时和编译器共享的字段语义

这类通信解决的是“编译器输出什么，运行时才能认得懂”。

### 4.3 运行时执行通信

通信对象：

- `reactivity`
- `component`
- `dom`
- `render`

通信内容：

- signal 订阅关系
- scheduler 队列
- updater 运行结果
- slot dirty 标记
- DOM 写入与 hydration 接管

这类通信解决的是“状态变化如何穿过运行时，最终落成 DOM”。

### 4.4 集成通信

通信对象：

- `vite-plugin`
- `compiler-tsx`
- `playground/*`

通信内容：

- `transform` 调用
- sourcemap
- HMR 刷新
- 编译错误到开发时 overlay 的映射

这类通信解决的是“作者写下 `.lania.tsx` 后，开发工具链如何把它变成可运行模块”。

### 4.5 质量通信

通信对象：

- `tests`
- `playground/*`
- `packages/*`
- `docs`

通信内容：

- 测试断言
- 浏览器验收
- benchmark 结果
- 文档事实回写

这类通信解决的是“当前主线是否仍然真实成立”。

## 5. 核心链路详解

### 5.1 开发启动链路

这是平时 `npm run dev` 触发的路径。

```text
根脚本
  -> playground/todo 启动 Vite
  -> Vite 加载 @lania-v/vite-plugin
  -> 读取 .lania.tsx 文件
  -> 进入编译链路
  -> 浏览器加载编译后的模块
  -> runtime 挂载组件
```

这里的关键协作是：

- 根脚本决定默认入口
- `playground/todo` 提供真实页面和交互
- `vite-plugin` 决定哪些文件走编译主线
- `runtime` 决定浏览器里最终怎样执行

### 5.2 TSX 编译链路

这是项目最核心的编译主线。

```text
.lania.tsx
  -> compiler-tsx.parse
  -> compiler-tsx.compile
  -> compiler-core.pipeline
  -> lowering 到 Component IR
  -> dependency analysis
  -> renderPlan 重建
  -> slot allocation
  -> updater generation
  -> render / SSR / class codegen
  -> emit ES module
```

每一步的职责如下：

1. `compiler-tsx` 读取源码，识别函数组件、模板、signals、lifecycle、bindings
2. `compiler-tsx` 把 authoring 语法收敛成统一组件声明
3. `compiler-core` 把组件声明 lower 到 `Component IR`
4. `compiler-core` 做依赖分析，得出哪些 signal 驱动哪些 slot / updater
5. `compiler-core` 生成 `renderPlan`，把静态骨架和动态绑定表收口
6. `compiler-core` 分配 slot、生成 updater
7. `compiler-core` 生成 render code、SSR code、类组件代码
8. `compiler-tsx` 把这些产物包装成最终模块

这一条链路的输出不是单一字符串，而是“运行时代码 + 静态模板 + 协议数据”的组合。

### 5.3 Vite 集成链路

这是编译器进入工具链的路径。

```text
Vite transform
  -> vite-plugin 过滤 .lania.tsx
  -> 调 compiler-tsx
  -> TypeScript transpileModule
  -> 返回 JS + sourcemap
  -> 浏览器执行
```

错误链路也走这里：

```text
compiler error
  -> LaniaTsxCompileError
  -> vite-plugin 转成 Vite 错误对象
  -> overlay 定位到源码行列
```

所以 `vite-plugin` 的价值主要是开发体验，而不是编译决策。

### 5.4 首次挂载链路

这是编译产物第一次真正进入页面的路径。

```text
编译后的组件类 / JSX 可渲染值
  -> createRoot() 或组件宿主
  -> render.mountStaticTemplate()
  -> 建立 slotTable
  -> 创建各类 slot
  -> 初始化 updater
  -> 完成首次 DOM 挂载
```

这里分两种典型情况：

- 直接 `createRoot(container).render(<App />)`：轻量挂载器直接消费可渲染值
- 编译产物类组件：`ReactiveElement` 负责样式、生命周期、`_renderAndMount()` 和 updater flush

这一步的重点不是 diff，而是“用静态模板快速建骨架，再用 slot 接上动态部分”。

### 5.5 响应式更新链路

这是运行时最重要的一条执行链。

```text
signal.set()
  -> signal 记录变更
  -> scheduler.scheduleSignal()
  -> 微任务 flush
  -> updater.run()
  -> slot.write(value)
  -> DOM update
```

其中分工是：

- `signal` 负责保存值和订阅关系
- `scheduler` 负责执行顺序和批量刷新
- `updater` 负责“计算新的动态值”
- `slot` 负责“把值写到正确 DOM 位置”

这条链路是项目拒绝 Virtual DOM 的关键原因：状态变化直接命中真实更新点，而不是先构建整棵虚拟树再 diff。

### 5.6 组件通信链路

函数组件之间的通信主要有五种。

#### Props

```text
父组件传值
  -> 编译产物/组件宿主写入 props
  -> 子组件通过 props 或 bindProps() 读取
```

#### 回调型输入

```text
父组件传 handler
  -> 子组件通过 bindHandlers() 读取
  -> 在事件中调用父组件回调
```

#### Slots

```text
父组件提供 children / named slots
  -> 运行时 scope 保存 slotContent
  -> 子组件通过 bindSlots() 读取与渲染 fallback
```

#### Ref / Expose

```text
父组件传 ref
  -> 子组件 createExpose()
  -> 暴露公开面给父组件
```

#### Context

```text
祖先 provideContext()
  -> 宿主树保存上下文
  -> 后代 useContext() 读取
```

这部分通信不依赖全局单例，而是依赖宿主和运行时 scope。

### 5.7 DOM 绑定链路

这条链路说明编译后的绑定最终怎么落到 DOM。

```text
模板中的事件 / class / style / html / model / use
  -> 编译进入 renderPlan 对应 binding
  -> runtime 创建具体 slot
  -> updater 计算新值
  -> slot 执行 DOM 写入或事件绑定
```

典型对应关系是：

- 文本 -> `TextSlot`
- class -> `ClassSlot`
- style -> `StyleSlot` / `StyleObjectSlot`
- 事件 -> `EventSlot`
- 指令 -> `DirectiveBindingSlot` / `UseDirectiveSlot`
- 组件 props -> `ComponentSlot`
- 列表 / 条件 / 动态节点 -> `ForSlot` / `IfSlot` / `DynamicSlot`

所以 runtime 的 DOM 层不是一个统一大渲染器，而是一组分工明确的 slot 执行器。

`ForSlot` 的 keyed 列表有两种 block 定位模式：

- **注释锚点模式**：`start` / `end` 两个注释包围条目内容，过渡、保活、SSR 复用都依赖这对边界。
- **元素自锚定模式**：当宿主没有过渡/保活钩子、且条目模板只产出一个元素时，直接用该元素作为定位依据，省掉每条 item 的两个注释节点。重排、删除、移动都退化为对这个元素的原生操作。

两种模式共享同一套 keyed diff 与实例生命周期，差异只在"怎么找到这段 DOM"。

### 5.8 增强组件链路

增强组件分三类。

#### 结构类

如 `When`、`Each`、`Dynamic`、`Fragment`、`Teleport`。

主链路是：

```text
增强组件 authoring
  -> compiler 识别 registry / contract
  -> lowering 到结构型节点或 boundary payload
  -> runtime 进入对应 slot 执行
```

这类能力的重点是“编译期定义结构，运行时只执行结构”。

#### 边界类

如 `ErrorBoundary`、`Suspense`、`LazyLoad`。

主链路是：

```text
props / payload
  -> BoundaryPayload
  -> boundary host / registry
  -> BoundarySlot
  -> child / fallback 切换
```

这类能力的重点是“边界状态和恢复协议”。

#### 生命周期 / 缓存 / 过渡类

如 `KeepAlive`、`Transition`、`TransitionGroup`。

主链路是：

```text
props / payload
  -> runtime controller / registry
  -> cache activation 或 transition runtime
  -> DOM host / snapshot host
  -> 可见内容切换
```

这类能力的重点不是普通数据更新，而是实例保留、激活、动画阶段和宿主协作。

### 5.9 SSR 与 Hydration 链路

这是服务端与客户端协作的链路。

#### SSR

```text
renderPlan / slot bindings
  -> ssrRenderTextSlot / ssrRenderBlockSlot
  -> 输出静态 HTML + markers
  -> boundary / teleport / suspense 输出协议化标记
```

SSR 输出的关键不是“把页面拼成字符串”，而是“把客户端后续接管所需的信息也一并输出”。

#### Hydration

```text
客户端 mountStaticTemplate()
  -> 扫描已有 DOM 和 markers
  -> 恢复 hydrationSlots / hydrationBoundaries
  -> 首次 slot.write() 优先接管已有节点
  -> 后续更新继续走正常 updater -> slot 链路
```

Hydration 的本质是复用已有 DOM，而不是重建一遍 DOM。

### 5.10 测试与基准链路

#### 单元 / 集成

```text
Vitest
  -> alias 到 packages/*/src
  -> 直接执行源码测试
  -> 验证 compiler/runtime/shared 行为
```

#### E2E

```text
Playwright
  -> 启动 playground/todo
  -> 浏览器访问页面
  -> 验证真实交互和渲染
```

#### Benchmark

```text
Playwright
  -> 启动 playground/benchmark
  -> 执行多轮样本
  -> 生成 latest.json / latest.md
```

这三条链路一起保证：

- 核心算法没回退
- 浏览器行为没回退
- 性能轮廓可持续观察

### 5.11 构建与发布链路

```text
npm run build
  -> workspaces 逐包构建
  -> tsc 输出 dist
  -> 部分包执行 ESM specifier 修补

npm run release
  -> build
  -> changeset publish
```

这里的重点不是业务逻辑，而是发布边界：

- `packages/*` 是发布单元
- `playground/*` 不是发布单元
- 根脚本只做 orchestration，不直接生成框架产物

## 6. 读代码时最值得抓住的三条主线

如果只想快速建立完整心智模型，先抓住下面三条。

### 6.1 编译主线

```text
TSX -> parse -> IR -> analyze -> renderPlan -> codegen
```

看这条线时，重点问题是：

- 写法是怎样被收敛成统一结构的
- 依赖分析如何决定 updater 和 slot
- `renderPlan` 为什么是运行时真正需要的输入

### 6.2 更新主线

```text
Signal -> Scheduler -> Updater -> Slot -> DOM
```

看这条线时，重点问题是：

- 为什么状态变化不需要整树 diff
- 为什么 updater 和 slot 是分开的两层
- 为什么 DOM 更新可以稳定定位到局部节点

### 6.3 服务端主线

```text
renderPlan -> SSR markers -> hydration recovery -> normal updates
```

看这条线时，重点问题是：

- SSR 输出给客户端留下了哪些恢复信息
- Hydration 如何避免重复创建 DOM
- 边界类能力为什么必须依赖 marker / payload 协议

## 7. 一句话总结

这个仓库可以概括成一句话：

`compiler-tsx` 把作者写法收敛为统一输入，`compiler-core` 把输入编译成 `renderPlan + updater + slot` 协议，`runtime` 负责按这套协议执行 DOM、边界和 SSR/Hydration，`vite-plugin`、`playground`、`tests` 则分别负责开发接入、人工验收和自动验证。
