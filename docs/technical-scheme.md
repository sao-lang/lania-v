# lania-v 技术方案

> 本文档是 `lania-v` 当前阶段的唯一架构入口。
> 目标是把“方向正确”收敛为“可以持续落地、可以持续验收”的主线。

## 1. 一句话定义

`lania-v` 是一个编译优先的细粒度 Web Components 框架。

唯一主线为：

```text
TSX / FC -> Component IR -> renderPlan -> Updater -> Slot -> DOM
```

补充理解：

- `.lania.tsx` 是当前唯一输入方式。
- `Component IR` 与 `renderPlan` 是统一编译核心。
- `Signal -> Updater -> Slot -> DOM` 是统一运行时更新链路。
- 项目明确拒绝 Virtual DOM 和整树 diff 作为主更新模型。

## 2. 文档分层

当前文档按下面的层级理解：

- `technical-scheme.md`：唯一架构入口，定义主线、边界和收敛规则。
- `runtime-api.md`：运行时 API 以及 `FC / TSX` 主路径。
- `ssr-hydration.md`：SSR / Hydration 协议与边界。
- `plan.md`：执行计划与验收清单。
- `stages.md`：阶段性状态、版本收敛目标与历史说明。

## 3. 总体架构

框架分为五层：

```text
Authoring
  ├─ FC / TSX

Compiler
  ├─ Parse
  ├─ Normalize AST
  ├─ Component IR
  ├─ Dependency Analysis
  ├─ renderPlan
  └─ Codegen

Runtime
  ├─ ReactiveElement
  ├─ Signal / Computed / Effect
  ├─ Scheduler
  ├─ Updater
  └─ Slot

Integration
  ├─ Vite Plugin
  ├─ Playground
  └─ Debug / HMR Hooks

Quality
  ├─ Tests
  ├─ Examples
  └─ Docs
```

统一更新链路：

```text
Signal.set
  -> Scheduler
  -> Updater.run
  -> Slot.write
  -> DOM update
```

## 4. 分层边界

### 4.1 Compiler

编译器只认一条主链：

```text
template / tsx
  -> normalized AST
  -> Component IR
  -> dependency analysis
  -> renderPlan
  -> codegen
```

职责：

- 解析 `TSX` 输入。
- 把输入统一降级到 `Component IR`。
- 进行依赖分析、slot / updater 分配和代码生成。
- 为 SSR / Hydration 生成统一协议化产物。

约束：

- `codegen` 只消费统一 IR 与 `renderPlan`。
- 不允许为同一能力长期维护双份语义旁路。
- 不允许把大量语义解释回流到 runtime。

### 4.2 Runtime

`packages/runtime` 负责：

- `ReactiveElement`
- `Signal / Computed / Effect / Store / Resource`
- `Scheduler`
- `Updater`
- `Slot`
- 通用运行时 API，如 `context`、`ref`、`emit`、样式注入

`packages/runtime` 不负责：

- AST 解析
- TSX 语法转换
- 模板结构编译
- 为单一入口写专用解释器

原则：

- Runtime 保持小而稳定。
- Runtime 不反向依赖编译器包。
- Runtime API 必须可测试、可在 playground 验证。

### 4.3 Host

`ReactiveElement` 是宿主基座，不是第二套渲染内核。

它只负责：

- Web Components 生命周期承接
- 编译产物实例容器
- 调度、挂载、销毁入口
- 与 slot / updater / runtime host 的协作

任何试图把新的 diff 流程或解释式渲染逻辑重新塞回 `ReactiveElement` 的设计，都视为偏离主线。

### 4.4 Integration 与 Playground

`packages/vite-plugin` 负责：

- 文件过滤
- 调用编译器
- sourcemap 透传
- 错误定位与开发体验
- HMR 钩子接线

`playground/*` 只负责：

- 示例验证
- 开发期回归
- 对外演示最小能力

不允许在 playground 中承载真实框架逻辑，也不允许直接跨目录引用 `packages/*/src/*`。

## 5. 收敛规则

### 5.1 单入口单内核

项目当前只保留一个一等入口：

- `FC / .lania.tsx`

其要求是：

- 写法稳定
- 语义统一
- 编译主链单一
- 运行时执行模型单一

### 5.2 公开 API 原则

新公开 API 必须同时满足：

- 能映射到现有 `Component IR` 或少量可解释的统一扩展节点。
- 能落到现有 `renderPlan / updater / slot` 协议。
- 不要求新增解释式运行时。
- 不要求为同一能力长期维护双份语义。

不能满足以上条件的能力，不进入主线。

### 5.3 生命周期与指令原则

- `FC` 生命周期保持少而稳，只保留高价值阶段。
- 宿主级生命周期继续下沉到宿主层，不回流为普通 `FC` API。
- 指令系统收敛到 `FC / TSX` 主路径，优先使用对象型 props 或标准 TSX 写法。

### 5.4 兼容路径原则

以下路径可以保留，但不反向定义主线：

- 直接 `jsx-runtime` 执行路径
- 过渡期兼容别名
- 宿主层特定入口

兼容路径只服务兼容和轻量接入，不得成为正式语义来源。

## 6. 文档与术语规则

对外文档默认只保留以下一级术语：

- `Component IR`
- `renderPlan`
- `Signal`
- `Updater`
- `Slot`
- `ReactiveElement`

其它术语只能作为补充解释，不能与这些概念争夺核心位置。

说明顺序默认遵循：

1. 先讲 `renderPlan` 是什么。
2. 再讲 `Signal -> Updater -> Slot -> DOM` 如何执行。
3. 最后再讲 `FC / TSX` 如何进入这条编译主链。

## 7. 当前阶段判断

当前项目的稳定结论如下：

- 编译产物路径是正式语义来源。
- `.lania.tsx` 是当前唯一正式输入路径。
- runtime JSX 直执行路径仍存在，但只应视为兼容层。
- 增强组件、SSR / Hydration 已进入主路径，但复杂组合仍优先以测试和 playground 为准。
- 历史设计背景只用于追溯，不再承担当前主方案角色。

## 8. 当前推荐执行顺序

```text
L0 已完成：工程基建、质量工具、最小 playground
L1 已完成：最小 runtime / compiler 闭环
L2 进行中：主功能收口、增强组件与 SSR 主线稳定化
L3 后续：性能、类型、插件、并发、调试增强
```

下一阶段优先级：

1. 保持 `IR / renderPlan / updater / slot` 主链一致。
2. 继续压缩兼容旁路，而不是扩张新语法。
3. 用测试和 playground 验证复杂组合场景。
4. 先稳定已有能力，再做性能与工程化扩展。

## 9. PR 准入问题

任意功能 PR 进入主线前，至少回答下面 6 个问题：

1. 它落在哪一层：语法层、IR 层、renderPlan 层、slot 层还是宿主层？
2. 它是否复用统一 `FC / TSX` 语义？
3. 它是否新增了平行运行时路径？
4. 它是否绕开了 `Component IR` 或 `renderPlan`？
5. 它是在强化核心模型，还是在扩大表层 API？
6. 它是否让兼容路径反过来影响主路径定义？

如果这些问题无法清晰回答，PR 不进入主线。

## 10. 验收原则

一个能力只有同时满足下面条件，才算完成：

- 有真实代码
- 有定向测试或可重复人工验收
- 有 playground 或输入/输出样例
- 与 `technical-scheme.md`、`stages.md` 和 `plan.md` 语义一致

不允许：

- 只有运行时占位实现就标记“编译能力完成”
- 只有 parser 占位就标记“编译器完成”
- 只有 demo 能跑就标记“章节完成”
