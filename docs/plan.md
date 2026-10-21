# lania-v 完整版开发计划明细

> 本文件依据 `docs/technical-scheme.md` 与 `docs/stages.md` 逐章拆解，作为当前执行主计划。
> 技术栈默认：`Vite + TypeScript`
> 计划分层：`L0 基建`、`L1 可运行闭环`、`L2 功能完整`、`L3 生产优化`
> 规则：每个条目都必须可验收；完成后将 `- [ ]` 改为 `- [x]`

## 0. 使用规则

### 0.1 状态语义

- `[ ]` 表示未完成，或只完成了局部实验、草稿代码、未验收实现
- `[x]` 表示已落地代码、已有定向测试或可重复人工验收、且与当前主线文档语义一致
- `[-]` 表示明确不纳入当前版本，但必须保留原因、影响范围和后续处理方式
- 不允许因为“能跑通主路径”就提前将未闭环能力标为 `[x]`
- 只完成 runtime 不算完成编译能力；只完成编译不算完成运行时能力

### 0.2 事实来源

- 主方案来源：`docs/technical-scheme.md`
- 当前主技术方案：`docs/technical-scheme.md`
- 主计划来源：`docs/plan.md`
- 当前实现来源：后续实际代码目录
- 验收结论必须同时对照“方案语义 + 当前代码 + 测试/示例”

### 0.3 执行规则

- 新功能开始前先在本文件定位对应条目
- 若当前主线文档出现新增能力，先更新本文件再开发
- 每完成一个功能立即回填状态
- 每个里程碑完成后补一条验收记录
- 每个章节开发结束后补对应测试条目
- 每个运行时模块完成后补 playground 示例
- 每个编译器阶段完成后补输入/输出样例

### 0.4 当前基线判断

- [x] 当前项目已经完成 `L0`，并已具备最小 runtime 可运行闭环
- [x] 当前主风险已从“仓库未初始化”转为“runtime 与 compiler 语义能否继续收敛”
- [x] 当前最缺的不是基础脚手架，而是最小 TSX 编译链、组件通信主路径与编译器 AST/IR 骨架
- [x] 后续章节必须以“代码 + 测试 + playground/输入输出样例 + 对账闭合”为完成标准

### 0.5 关键缺口提醒

- [x] `Signal / Scheduler / Slot` 已形成最小可运行闭环
- [x] `PropSlot / EventSlot / ComponentSlot / MultiSlotUpdater / ConditionUpdater` 已形成可运行主路径并具备定向测试
- [x] TSX 编译链、SSR/Hydration、增强组件已具备基础版闭环，不再仅停留在计划层
- 高级能力如 `KeepAlive / TransitionGroup / Suspense / Streaming SSR / 插件系统` 极易返工，必须延后到编译主链稳定后推进

### 0.6 高优先级阻塞依赖

- [x] `Core` 最小闭环已经具备，可继续推进通信与编译章节
- [x] `PropSlot / EventSlot / ComponentSlot` 主路径已完成，不再阻塞组件通信与 TSX 事件主线
- [x] `Compiler IR / Dependency Analysis / Codegen` 主链已稳定，不再阻塞 TSX 主路径铺开
- `IfSlot / ForSlot / ComponentSlot` 未完成前，不开始 `<When> / <Each> / <Teleport> / <KeepAlive>`
- `ErrorBoundary / async resource / async scheduler hooks` 未完成前，不开始完整 `<Suspense>`
- [x] `测试矩阵` 与编译样例已建立，可继续按验收结果回填编译章节状态

## 1. 分层定义

- [x] `L0`：项目可安装、可构建、可测试、可预览
- [x] `L1`：最小运行时和最小编译器闭环跑通
- `L2`：当前主线文档定义的主功能全部可用
- `L3`：性能、类型、SSR、并发、插件、调试补齐

## 2. 全局工程基建

### 2.1 仓库结构

- [x] 初始化根目录 `package.json`
- [x] 初始化根目录 `tsconfig.json`
- [x] 初始化根目录 `.gitignore`
- [x] 初始化根目录 `.editorconfig`
- [x] 初始化根目录 README 占位
- [x] 建立 `packages/reactivity`（响应式核心从 runtime 提取）
- [x] 建立 `packages/runtime`
- [x] 建立 `packages/advanced`（增强组件从 runtime 拆出）
- [x] 建立 `packages/store`
- [x] 建立 `packages/compiler-core`
- [x] 建立 `packages/compiler-tsx`
- [x] 建立 `packages/vite-plugin`
- [x] 建立 `packages/shared`
- [x] 建立 `playground/basic`
- [x] 建立 `playground/compiler`

### 2.2 脚本体系

- [x] 配置 `dev`
- [x] 配置 `build`
- [x] 配置 `typecheck`
- [x] 配置 `test`
- [x] 配置 `lint`
- [x] 配置 `format`
- [x] 配置 `build:runtime`
- [x] 配置 `build:compiler`
- [x] 配置 `dev:playground`

### 2.3 工程约定

- [x] 约定包之间的引用边界
- [x] 约定运行时公共导出入口
- [x] 约定编译器公共导出入口
- [x] 约定内部类型命名规则
- [x] 约定编译产物目录结构
- [x] 约定 playground 引用本地包方式

### 2.4 质量工具

- [x] 接入测试框架
- [x] 接入断言库
- [x] 接入覆盖率配置
- [x] 接入 ESLint
- [x] 接入 Prettier
- [x] 接入 Markdown 校验
- [x] 接入 `husky`
- [x] 接入 `commitlint`
- [x] 接入 `commitizen`
- [x] 接入 `cz-git`
- [x] 配置 `commit-msg` Git Hook
- [x] 配置 `pre-commit` Git Hook
- [x] 配置 `pre-push` Git Hook
- [x] 约定提交信息规范
- [x] 建立提交规范文档

### 2.5 技术选型与依赖策略

- [x] 建立主技术方案文档
- [x] 明确 runtime / compiler / integration 分层边界
- [x] 明确“核心语义自研、基础设施复用”的选型原则
- [x] 明确 `TypeScript AST + MagicString` 的 transform 主策略
- [x] 明确推荐依赖矩阵与禁用依赖清单
- [x] 将推荐依赖正式接入对应编译包

## 3. 第 1 章：核心基础模块 (Core)

### 3.1 ReactiveElement 基类

- [x] 定义 `ReactiveElement` 抽象基类
- [x] 实现继承 `HTMLElement`
- [x] 实现 `renderRoot` / `shadowRoot` 初始化
- [x] 约定默认使用 `ShadowRoot`
- [x] 支持配置 Light DOM 渲染模式
- [x] 实现 `_slots` 存储
- [x] 实现 `_updaters` 存储
- [x] 实现 `_dirty` 脏标记字段
- [x] 实现 `_scheduler` 引用
- [x] 实现 `_isMounted`
- [x] 实现 `_isConnected`
- [x] 实现首轮挂载流程
- [x] 实现重复连接保护
- [x] 实现断开连接清理逻辑

### 3.2 生命周期基础

- [x] 实现 `connectedCallback`
- [x] 实现 `disconnectedCallback`
- [x] 实现 `attributeChangedCallback`
- [x] 实现 `adoptedCallback`
- [x] 预留 `errorCallback`
- [x] 实现生命周期调用顺序控制
- [x] 实现首次挂载只执行一次
- [x] 实现组件销毁后禁止继续写 DOM

### 3.3 生命周期更新钩子

- [x] 实现 `requestUpdate`
- [x] 实现 `performUpdate`
- [x] 实现 `shouldUpdate`
- [x] 实现 `willUpdate`
- [x] 实现 `updated`
- [x] 实现 `firstUpdated`
- [x] 打通生命周期与 Scheduler 的统一入口
- [x] 实现更新前后 changedProps 记录

### 3.4 Signal 基础结构

- [x] 定义 `Signal<T>` 类型接口
- [x] 定义 `SignalSetter<T>` 类型
- [x] 实现 `createSignal(initialValue)`
- [x] 实现 signal 读取函数语义
- [x] 实现 `.set(value)`
- [x] 实现 `.set(updaterFn)`
- [x] 实现 `Object.is` 比较短路
- [x] 实现 `signal.updaters`
- [x] 实现更新时遍历 updaters
- [x] 实现更新时进入统一调度

### 3.5 静态 DOM + 动态槽位

- [x] 约定 DOM 只创建一次
- [x] 实现静态节点一次性创建
- [x] 实现动态文本槽位引用保存
- [x] 实现动态属性槽位引用保存
- [x] 实现动态样式槽位引用保存
- [x] 实现动态类名槽位引用保存
- [x] 实现初次挂载后执行 `_flushUpdaters`

### 3.6 Core 验证

- [x] 实现最小 `CounterElement`
- [x] 验证文本更新链路
- [x] 验证属性更新链路
- [x] 验证样式更新链路
- [x] 验证组件断开后更新无效
- [x] 验证生命周期触发顺序

## 5. 第 3 章：组件通信系统

### 5.1 Props / Attributes

- [x] 支持父组件静态 props 传子组件
- [x] 支持父组件动态 props 传子组件
- [x] 支持 attribute 映射为子组件 property
- [x] 支持 property signal 化写入

### 5.2 自定义事件

- [x] 实现 `emit(name, detail)`
- [x] 事件默认使用 `CustomEvent`
- [x] 支持 `bubbles`
- [x] 支持 `composed`
- [x] 支持 `FC onXxx={handler}` 监听子组件事件
- [x] 保留 `on:event` 作为 `directive-extended` 兼容入口
- [x] 支持父组件监听子组件事件

### 5.3 Context API

- [x] 实现 `createContext`
- [x] 实现 `provideContext`
- [x] 实现 `consumeContext`
- [x] 实现 DOM 冒泡查找 provider
- [x] 支持找不到 provider 的默认值

### 5.4 Ref

- [x] 实现 DOM ref
- [x] 实现组件实例 ref
- [x] 支持 TSX `ref={...}`
- [x] 支持函数组件 ref

## 6. 第 4 章：事件系统架构

### 6.1 TSX 事件绑定

- [x] 支持 `onClick={handler}`
- [x] 支持 `onInput={handler}`
- [x] 支持 `onChange={handler}`
- [x] 支持常见 DOM 事件映射

### 6.2 事件修饰符

- [x] 支持 `.stop`
- [x] 支持 `.prevent`
- [x] 支持 `.enter`
- [x] 预留更多键盘修饰符扩展
- [x] 支持多修饰符组合

### 6.3 自定义事件与静态化

- [x] 支持组件自定义事件监听
- [x] 实现事件 handler 静态化
- [x] 避免每次渲染重新创建监听函数
- [x] 支持事件解绑清理

## 7. 第 5 章：渲染模块

### 7.1 无虚拟 DOM 渲染

- [x] 建立“直接操作 DOM”运行时原则
- [x] 实现静态 DOM 一次创建
- [x] 实现动态内容直接写真实 DOM
- [x] 明确不引入 VDOM 和 diff

### 7.2 编译后渲染函数

- [x] 生成 `_renderAndMount()`
- [x] 在其中创建静态树
- [x] 在其中创建动态槽位
- [x] 在其中注册 updater
- [x] 在其中进行首次赋值

### 7.3 批量插入与静态提升

- [x] 支持 `DocumentFragment` 批量插入
- [x] 支持静态子树提升到模块级
- [x] 支持组件实例 clone 静态树

### 7.4 渲染层验证

- [x] 对比同组件多次状态更新的 DOM 写入次数
- [x] 验证静态节点不重复创建
- [x] 验证动态节点只更新对应位置

## 8. 第 6 章：样式系统

### 8.1 `css` 模板标签

- [x] 实现 `css` 标签函数
- [x] 支持返回 `CSSStyleSheet`
- [x] 支持返回可序列化样式对象

### 8.2 `static styles`

- [x] 约定组件 `static styles`
- [x] 支持单个 stylesheet
- [x] 支持 stylesheet 数组

### 8.3 adoptStyles

- [x] 实现 `adoptStyles()`
- [x] 优先使用 `adoptedStyleSheets`
- [x] 不支持时回退 `<style>`
- [x] 避免重复注入样式

### 8.4 动态样式绑定

- [x] 支持 style 对象写法
- [x] 支持 `FC style={...}` 的字符串 / 对象 / 数组归一化
- [x] 支持静态 `style="..."` 与动态 `style={...}` 合并
- [x] 保留 `style:prop={expr}` / `style:width.px={expr}` 作为 `directive-extended` 兼容入口
- [x] 细粒度更新具体 style 属性

### 8.5 CSS 变量系统

- [x] 支持 CSS 变量注入
- [x] 支持 `:host` CSS 变量注入
- [x] 支持组件继承 CSS 变量

## 9. 第 7 章：指令系统

### 9.1 基础指令语法

- [x] 支持 `FC onClick={handler}` / `onToggle={handler}` 主路径
- [x] 保留 `click={handler}` / `on:event` 作为 `directive-extended` 兼容入口
- [x] 支持 `FC value={...}` / `checked={...}` DOM 属性写入主路径
- [x] 保留 `bind:value` 作为 `directive-extended` 兼容入口
- [x] 支持 `FC model={{ target, modifiers }}` 主路径
- [x] 支持 `FC className={...}` 归一化主路径
- [x] 支持 `FC style={...}` 归一化主路径
- [x] 保留 `style:color` 作为 `directive-extended` 兼容入口

### 9.2 事件修饰与绑定增强

- [x] 支持 `FC onClick={{ handler, modifiers }}` / `onKeydown={{ handler, modifiers }}` 主路径
- [x] 保留 `click.stop.prevent` / `keydown.enter` 作为 `directive-extended` 兼容入口
- [x] 支持 `FC model` 修饰符对象语义
- [x] 保留 `model:value.trim` / `model:value.number` / `model:value.trim.number` 作为 `directive-extended` 兼容入口

### 9.3 指令初始化分离

- [x] 指令 setup 只执行一次
- [x] 指令更新逻辑独立生成 updater
- [x] 避免每次更新重复 setup

### 9.4 自定义指令

- [x] 设计 `DirectiveDef`
- [x] 支持 `mounted`
- [x] 支持 `updated`
- [x] 支持 `unmounted`
- [x] 支持 `FC use={{ name: value }}` 主路径
- [x] 保留 `use:directive` 作为 `directive-extended` 兼容入口

## 10. 第 8 章：编译器架构

### 10.1 Compiler Pipeline

- [x] 建立 `Source -> AST -> IR -> Codegen` 总流程
- [x] 拆分 TSX 编译入口
- [x] 统一流向 `ComponentIR`

### 10.2 Parser

- [x] 接入 TypeScript AST
- [x] 解析函数组件
- [x] 解析 TSX

### 10.3 AST 结构

- [x] 定义 `Program`
- [x] 定义 `ComponentDeclaration`
- [x] 定义 `SignalDeclaration`
- [x] 定义 `ComputedDeclaration`
- [x] 定义 `EffectDeclaration`
- [x] 定义 `TemplateNode`
- [x] 定义 `ElementNode`
- [x] 定义 `TextNode`
- [x] 定义 `ExpressionNode`
- [x] 定义 `AttributeNode`
- [x] 定义 `EventNode`
- [x] 定义 `DirectiveNode`

### 10.4 Component IR

- [x] 定义 `ComponentIR`
- [x] 定义 `PropIR`
- [x] 定义 `SignalIR`
- [x] 定义 `ComputedIR`
- [x] 定义 `EffectIR`
- [x] 定义 `LifecycleIR`
- [x] 定义 `TemplateIR`
- [x] 实现 AST -> ComponentIR

### 10.5 Template IR

- [x] 定义 `ElementIR`
- [x] 定义 `TextIR`
- [x] 定义 `ExpressionIR`
- [x] 定义动态属性 IR
- [x] 定义事件 IR
- [x] 定义指令 IR

### 10.6 Dependency Analysis

- [x] 分析表达式中使用的 signal
- [x] 建立 `Signal -> Slot` 映射
- [x] 建立 `Signal -> Updater` 映射
- [x] 识别 computed 依赖链
- [x] 识别 effect 依赖链
- [x] 识别深层路径访问

### 10.7 Slot Allocation

- [x] 为动态文本分配 slot
- [x] 为动态属性分配 slot
- [x] 为动态样式分配 slot
- [x] 为动态 class 分配 slot
- [x] 为事件分配 slot
- [x] 为指令分配 slot
- [x] 为条件分支分配 slot
- [x] 为列表分支分配 slot

### 10.8 Updater Generation

- [x] 生成单 slot updater
- [x] 生成多 slot updater
- [x] 生成条件 updater
- [x] 生成 computed updater
- [x] 生成 effect updater

### 10.9 Optimization Pass

- [x] 实现 `Static DOM Hoisting`
- [x] 实现 `Constant Folding`
- [x] 实现 `Expression Merge`
- [x] 实现 `Slot Packing`
- [x] 实现 `Computed Inline`

### 10.10 Code Generation

- [x] 生成功能组件运行时输出
- [x] 生成 `_renderAndMount()`
- [x] 生成 slot 初始化代码
- [x] 生成 updater 绑定代码
- [x] 生成生命周期桥接代码
- [x] 生成样式注入代码

### 10.11 编译输出验证

- [x] 编译最小 Counter
- [x] 编译带属性组件
- [x] 编译带事件组件
- [x] 编译带条件组件
- [x] 编译带列表组件
- [x] 编译函数组件

## 11. 第 9 章：Updater 与 Slot 系统

### 11.1 Updater 基础

- [x] 定义 `Updater` 接口
- [x] 定义 `BaseUpdater`
- [x] 支持 `deps`
- [x] 支持 `slots`
- [x] 支持 `priority`
- [x] 支持 `dirty`
- [x] 支持 `attach`
- [x] 支持 `detach`

### 11.2 Updater 类型

- [x] 实现 `SimpleUpdater`
- [x] 实现 `MultiSlotUpdater`
- [x] 实现 `ConditionUpdater`
- [x] 支持后续 effect updater

### 11.3 Slot 类型系统

- [x] 定义 `SlotType`
- [x] 定义 `TEXT`
- [x] 定义 `ATTRIBUTE`
- [x] 定义 `PROPERTY`
- [x] 定义 `STYLE`
- [x] 定义 `CLASS`
- [x] 定义 `EVENT`
- [x] 定义 `IF`
- [x] 定义 `FOR`
- [x] 定义 `COMPONENT`
- [x] 定义 `DIRECTIVE`

### 11.4 Slot 通用接口

- [x] 定义 `type`
- [x] 定义 `node`
- [x] 定义 `index`
- [x] 定义 `frequency`
- [x] 定义 `write(value)`
- [x] 定义 `destroy()`

### 11.5 具体 Slot 实现

- [x] 实现 `TextSlot`
- [x] 实现 `AttrSlot`
- [x] 实现 `PropSlot`
- [x] 实现 `StyleSlot`
- [x] 实现 `ClassSlot`
- [x] 实现 `EventSlot`
- [x] 实现 `IfSlot`
- [x] 实现 `ForSlot`
- [x] 实现 `ComponentSlot`
- [x] 实现 `DirectiveSlot`

### 11.6 Slot 管理

- [x] 实现 Slot Table
- [x] 支持 slot 索引访问
- [x] 支持 slot 销毁遍历
- [x] 支持 slot 频率标记

### 11.7 Dirty 标记

- [x] 为 slot 分配 bit
- [x] 更新时设置 dirty
- [x] flush 时按 bit 执行
- [x] flush 后清空 dirty

## 12. 第 10 章：响应式调度模型

### 12.1 基础 Scheduler

- [x] 定义 `queue`
- [x] 定义 `scheduled`
- [x] 实现 `schedule()`
- [x] 实现 `flush()`
- [x] 使用 `Set` 去重
- [x] 使用 `queueMicrotask`

### 12.2 调度内容

- [x] 支持 Signal updater 任务
- [x] 支持组件生命周期任务
- [x] 支持 effect 尾部任务

### 12.3 Batch

- [x] 实现 `batch()`
- [x] batch 中合并多次 signal 更新
- [x] batch 结束只触发一次 flush

### 12.4 优先级调度

- [x] 定义 `IMMEDIATE`
- [x] 定义 `HIGH`
- [x] 定义 `NORMAL`
- [x] 定义 `LOW`
- [x] 定义 `IDLE`
- [x] 支持 `schedule(job, priority)`

### 12.5 并发与时间切片

- [x] 设计时间切片 `UnitOfWork`
- [x] 支持 `MessageChannel`
- [x] 评估 `requestIdleCallback`
- [x] 支持超时让出主线程
- [x] 支持 `createTransition`
- [x] 支持双缓冲状态模型

## 13. 第 11 章：SSR 编译策略

- [x] 当前 SSR 实现定位为“基础版 SSR 编译策略”，目标是先打通静态模板主路径
- [x] 第 11 章收口范围限定为“基础版 SSR / Hydration 编译策略”；完整版跨容器与流式能力转入 `21.4 L3`

### 13.1 服务端输出

- [x] 定义 SSR HTML 输出格式
- [x] 支持 slot anchor 标记
- [x] 支持服务端 `render(ctx)`
- [x] 支持表达式插入
- [x] 支持属性序列化
- [x] 条件分支 SSR 当前优先复用已存在的静态模板信息
- [x] 条件分支 SSR 已收口为基于静态模板的基础版策略；更通用的分支 SSR 编译策略转入 `21.4 L3`

### 13.2 客户端 Hydration

- [x] 解析现有 DOM
- [x] 扫描 slot markers
- [x] 重建 slot table
- [x] 恢复显式的 hydration 专用 signal-updater 绑定链路
- [x] 复用服务端 DOM
- [x] 避免重复创建节点

### 13.3 SSR 扩展

- [x] 为 Teleport / 增强组件 / Suspense 预留基础 SSR 边界
- [x] 增强组件完整 SSR 边界信息与恢复语义已完成（备注：已补齐增强边界元信息序列化、hydration 边界扫描/恢复接口与组合场景测试）
- [x] Teleport 完整跨容器 SSR 对齐已完成（备注：已补齐目标容器映射协议、服务端跨容器输出与客户端 Teleport hydration 对齐）
- [x] Suspense 完整流式 SSR 已完成（备注：已补齐流式 chunk 输出、异步回填协议与服务端/客户端协同恢复接口）

## 14. 第 12 章：函数式组件

### 14.1 `defineComponent`

- [x] 实现 `defineComponent`
- [x] 支持 props 入参
- [x] 支持编译为运行时组件输出

### 14.2 基础响应式 API

- [x] 支持 `createSignal`
- [x] 支持 `createMemo`
- [x] 支持 `createEffect`
- [x] 支持 `watch`
- [x] 支持 `readonly`
- [x] 支持 `untrack`
- [x] 支持 `isTracking`

### 14.3 数据与异步 API

- [x] 支持 `createStore`（已迁出：由 `@lania/store` 的 `createAtom` 承接）
- [x] 新增 `packages/store`（`@lania/store`）：原子化状态、派生、动作、原子族、作用域快照与中间件
- [x] 深层响应式
- [x] 支持 `createResource`
- [x] 支持 `createDeferred`
- [x] 支持 `lazy`
- [x] 支持 `createRoot`

### 14.4 组件上下文 API

- [x] 支持 `createContext`
- [x] 支持 `useContext`
- [x] 支持 `createRef`

### 14.5 生命周期 Hook

- [x] 支持 `onMount`
- [x] 支持 `onCleanup`
- [x] 支持 `onUpdated`
- [x] 保留兼容别名 `onMounted` / `onUnmounted`
- [x] 移除 `onBeforeUpdate` / `onUpdate`
- [x] 移除 `onError`，统一交给 `ErrorBoundary`
- [x] 下沉 `onAdopted` / `onAttributeChanged` 到宿主层

### 14.6 内置增强组件

- [x] 定义增强组件统一抽象
- [x] 提供 TSX 类型定义
- [x] 实现 `<When>`
- [x] 编译 `<When>` -> `IfSlot`
- [x] 实现 `<Each>`
- [x] 编译 `<Each>` -> `ForSlot`
- [x] 实现 `<Teleport>`
- [x] 实现目标容器解析
- [x] 实现 Teleport 卸载清理
- [x] 实现 `<KeepAlive>`
- [x] 实现缓存容器
- [x] 支持 `include`
- [x] 支持 `exclude`
- [x] 支持 `max`
- [x] 实现 `<Transition>`
- [x] 支持 `enter`
- [x] 支持 `leave`
- [x] 支持 `appear`
- [x] 实现 `<TransitionGroup>`
- [x] 支持列表进入动画
- [x] 支持列表移除动画
- [x] 支持列表移动动画
- [x] 实现 `<LazyLoad>`
- [x] 基于 `IntersectionObserver`
- [x] 支持 `fallback`
- [x] 支持一次性触发
- [x] 支持重复观察
- [x] 实现 `<ErrorBoundary>`
- [x] 支持错误 fallback
- [x] 支持错误重置
- [x] 实现 `<Suspense>`
- [x] 支持异步 fallback
- [x] 支持恢复真实子树
- [x] 实现 `<Dynamic>`
- [x] 支持动态标签与动态组件目标
- [x] 支持 `<component is={...}>` 映射
- [x] 实现 `<Fragment>`
- [x] 支持 Fragment 编译期拍平

## 15. 第 13 章：旧输入路线归档

- [x] 仓库主线已收敛为 `.lania.tsx`
- [x] 历史兼容路线已从当前代码与文档主路径移除
- [x] 后续计划不再为旧输入路线分配单独章节或验收项

## 16. 第 14 章：架构优化细节

- [x] 第 14 章收口范围限定为“基础版架构优化闭环”
- [x] 生产级裁剪、Tree-Shaking、静态 signal 消除与内存工程转入 `21.4 L3`

### 16.1 统一响应式系统

- [x] 所有组件状态统一 signal 化
- [x] property setter 转 `signal.set`
- [x] 消除独立 render diff 流程

### 16.2 编译优化细项

- [x] 实现 Signal Updater 扁平化
- [x] 实现 computed 内联
- [x] 实现 DOM 写入合并
- [x] 实现 DOM Property Fast Path
- [x] 实现 Style 细粒度更新
- [x] 实现事件委托可选模式
- [x] 实现 ref 延迟写入
- [x] 实现生命周期调用内联
- [x] 开发模式分离裁剪已完成（备注：已补齐独立 dev/prod 入口、构建时常量裁剪与 bundler 级验证）
- [x] Tree-Shaking 已完成（备注：已整理包入口 side-effect 边界、补充导出裁剪约束与 bundler 级摇树验证）

### 16.3 静态与缓存优化

- [x] 实现 Static Signal Folding（保守版，仅折叠并裁剪未使用的静态 signal）
- [x] 实现 Static Tree Hoisting
- [x] 实现 Slot 常量缓存
- [x] 实现 Slot 索引顺序优化

### 16.4 调度与内存优化

- [x] 实现 Scheduler 优先级优化
- [x] 实现时间切片 flush
- [x] 实现 Slot 对象池
- [x] 紧凑 Signal 存储已完成（备注：signal 依赖桶已改为更紧凑的数据布局，并补回归验证覆盖扩容/删除语义）

### 16.5 类型安全

- [x] 检查 Signal 与 Slot 类型兼容
- [x] 检查模板表达式类型
- [x] 检查 DOM property 绑定类型
- [x] 检查组件 props 类型

### 16.6 跨组件分析

- [x] 实现跨组件依赖分析
- [x] 为高频组件生成更高效 updater
- [x] 为代码分割预留分析结果

## 17. 测试与文档

### 17.1 单元测试

- [x] 为 Scheduler 添加测试
- [x] 为 Signal 添加测试
- [x] 为 Slot 添加测试
- [x] 为 Updater 添加测试
- [x] 为 ReactiveElement 添加测试
- [x] 为装饰器添加测试
- [x] 为编译器 AST/IR 添加测试
- [x] 为 Codegen 添加测试

### 17.2 集成测试

- [x] 为 TSX 编译输出添加集成测试
- [x] 为 SSR / Hydration 添加集成测试
- [x] 为增强组件添加集成测试

### 17.3 Playground

- [x] 建立 Counter 示例
- [x] 建立 Props / Events 示例
- [x] 建立 List / If 示例
- [x] 建立 Function Component 示例
- [x] 建立 Teleport / Suspense 示例

### 17.4 文档

- [x] 编写运行时 API 文档
- [x] 编写装饰器文档
- [x] 编写 TSX 语法文档
- [x] 编写增强组件文档
- [x] 编写 SSR / Hydration 文档
- [x] 建立精简版技术方案文档

## 18. Dev / Debug / 插件

### 18.1 开发模式

- [x] 增加 warning
- [x] 增加 assert
- [x] 区分 dev / prod 输出

### 18.1 Git 与提交规范

- [x] 建立 `commitlint.config.*`
- [x] 建立 `commitizen` 配置
- [x] 建立 `cz-git` 配置
- [x] 建立 `husky` 脚本目录
- [x] 在 `commit-msg` 中接入 `commitlint`
- [x] 在 `pre-commit` 中接入 lint / format / typecheck
- [x] 在 `pre-push` 中接入关键测试
- [x] 约定分支命名与提交信息风格
- [x] 约定 merge / squash / release 提交策略

### 18.2 调试能力

- [x] 增加 scheduler debug hook
- [x] 增加 signal 更新日志
- [x] 增加组件生命周期日志
- [x] 预留 devtools hook

### 18.3 插件能力

- [x] 实现编译器插件系统
- [x] 实现装饰器扩展插件
- [x] 实现模板 transform 插件
- [x] 实现运行时插件系统

## 19. 验收矩阵

### 19.1 运行时验收

- [x] 运行时宿主层有单元测试与 playground 示例
- [x] `Signal` 有读写、短路、批量更新测试
- [x] `Scheduler` 有去重、重入、batch 测试
- [x] `Slot` 各类型至少有定向测试
- [x] `Updater` 至少覆盖单 slot、多 slot、条件更新三类测试

### 19.2 编译器验收

- [x] AST 解析有输入输出样例
- [x] IR 生成有快照测试
- [x] Codegen 有快照测试
- [x] 最小 TSX 组件编译结果可运行
- [x] 编译错误有可读报错与定位信息

### 19.3 框架能力验收

- [x] 函数组件主路径可运行
- [x] compile-only lifecycle markers 已转为显式报错，不再静默 no-op
- [x] `createRoot` 定位已收敛为轻量挂载器
- [x] `.lania.tsx` 已具备专门的编译错误对象与 overlay 定位
- [x] FC 上下文桥接已收敛到显式 scope，不再依赖旧的全局 host bridge 名称
- [x] 样式系统主路径可运行
- [x] 指令系统主路径可运行
- [x] 组件通信主路径可运行
- [x] 增强组件至少有第一版示例
- [x] SSR / Hydration 至少有最小可运行示例

### 19.4 回归验收

- [x] 核心 playground 可完整启动
- [x] 关键 demo 更新后无明显行为回退
- [x] 文档示例代码与真实实现一致
- [x] 主线文档、`plan.md`、实际代码三者状态一致

## 20. 发布前 Gate

### 20.1 L1 Gate

- [x] 已完成 `Core` 最小闭环
- [x] 已完成最小 TSX 编译结果
- [x] 已有最小 Counter 示例
- [x] 已完成最小运行时闭环

### 20.2 L2 Gate

- [x] TSX / FC 主线可运行
- [x] FC 主线代码、测试、文档三侧状态一致并可关闭
- [x] 指令、样式、通信、增强组件均有示例
- [x] SSR / Hydration 雏形已打通
- [x] 关键章节均已补测试

### 20.3 L3 Gate

- [x] 编译优化已落地而非仅写在方案
- [x] 性能优化项已有基准或行为验证
- [x] 类型安全检查已进入编译流程
- [x] 调试、插件、并发能力已有最小可用实现

### 20.4 首次对外可用 Gate

- [x] 文档可指导从零创建示例
- [x] playground 覆盖主能力
- [x] 当前主线文档中的核心特性都有对应代码与说明
- [x] 无仍被误标为 `[x]` 的未闭环能力

## 21. 里程碑与交付顺序

### 21.1 L0

- [x] M0.1：工程初始化完成
- [x] M0.2：包结构与脚本可用
- [x] M0.3：测试与 playground 可启动

### 21.2 L1

- [x] M1.1：手写运行时 Counter 跑通
- [x] M1.2：最小 TSX 编译产物跑通
- [x] M1.3：Signal -> Updater -> Slot -> DOM 闭环验证完成
- [x] M1.4：最小运行时闭环验证完成

### 21.3 L2

- [x] M2.2：函数组件基础能力完整
- [x] M2.2.a：FC 主线收口完成
- [x] M2.4：组件通信基础能力完整
- [x] M2.5：增强组件第一版完整
- [x] M2.6：SSR / Hydration 基础版完整

### 21.4 L3

- [x] M3.1：编译优化完成
- [x] M3.2：运行时性能优化完成
- [x] M3.3：类型安全与跨组件分析完成
- [x] M3.4：并发与插件最小可用完成；完整流式 SSR 继续按后置项跟踪

## 22. 当前默认执行顺序

- [x] 第一步：完成第 2 节到第 4 节的最小运行时与装饰器闭环
- [x] 第二步：完成第 5 节到第 6 节的组件通信与事件主路径
- [x] 第三步：完成第 10 节前半段的 AST / IR / Codegen 最小骨架
- [x] 第四步：打通最小 TSX 编译结果与 `L1 Gate`
- [x] 第五步：回到第 7 节到第 16 节，逐步扩样式、指令、函数组件、SSR
- [x] 第六步：完善第 17 节到第 21 节的测试、文档、验收与里程碑

## 23. 编译边界与运行时原语收敛

### 23.1 编译边界

- [x] props 解构重写为 `this.<prop>`，保留依赖订阅
- [x] 支持同文件 type alias / interface / 交叉类型的 props 展开
- [x] 不支持的解构形态（默认值 / rest / 嵌套）给出明确编译错误
- [x] 无法静态展开 props 类型时，解构给出明确编译错误
- [x] 组件标签 spread props 进入运行时 props 表达式
- [x] 原生标签 spread 给出明确编译错误，不再静默丢弃
- [x] 被编译产物引用的模块级声明保留到输出
- [x] 组件静态配置（`Component.styles` 等）保留在 class 之后
- [x] updater 首轮动态依赖兜底，覆盖 composable 返回的 signal
- [x] `useFormValidity()` 生成表单校验 effect
- [x] 编译报告插件输出 slot / updater / 依赖统计

### 23.2 运行时原语

- [x] `createSelector()`
- [x] `startTransition()` / `useTransition()` / `transitionPending`
- [x] `produce()`
- [x] `createScope()` / `getOwner()` / `runWithOwner()`
- [x] `createUniqueId()`
- [x] `renderToString()` / `renderToStream()`
- [x] `installDevtoolsOverlay()`
- [x] 函数型 slot 的额外参数透传（scoped slot 运行时基础）

### 23.3 绑定视图 API 编译路径

- [x] 编译产物注入的 `props` 覆盖全部声明 prop，并通过 getter 回读实例 signal
- [x] prop setter 同步 `this.props`，函数型 prop 走 `setValue()` 保留原值
- [x] 生成 `static handlerKeys` 并在 `createComponentElement()` 构造前挂 metadata
- [x] 零参 `bindSlots()` 改写为 `bindSlots(this.props)`，从 `children` 读取插槽
- [x] `bindSlots().has(name)` 只判断具名槽本身
- [x] 编译产物端到端测试覆盖 props 更新 / handler 调用 / 具名与默认插槽

### 23.4 Typed props / emits

- [x] `defineComponent(fn, { props })` 支持 `type` / `attribute` / `reflect` / `default`
- [x] 支持 `converter.from` / `converter.to` 与 `validator`
- [x] `attribute: false` 的 prop 不进入 `observedAttributes`
- [x] prop 名默认按 kebab-case 映射 attribute
- [x] `defineComponent(fn, { emits })` 校验 `emit()` 事件名
- [x] 编译产物端到端测试覆盖反射、attribute 回读、Boolean 语义与 emits 告警

### 23.5 Scoped slot / Await / Virtual

- [x] `DynamicSlot` 把函数型 child binding 作为 `children` / `slotContent` 透传给组件目标
- [x] 增强组件注册表新增 `Await` / `Virtual`
- [x] `Await` 支持 fallback / delay / error 分支与 resolve / reject 回调
- [x] `Virtual` 支持固定行高窗口化、overscan、`key` 与滚动回调
- [x] 运行时 scoped slot 与 Await / Virtual 测试通过

### 23.6 Declarative Shadow DOM / 部分水合 / HMR

- [x] SSR 输出 `<template shadowrootmode>`，并内联静态样式
- [x] `renderToStringWithDeclarativeShadow()` / `renderStreamToDeclarativeShadow()` 同步与流式入口
- [x] 客户端接管未被平台消费的 DSD 模板，并登记已有 `<style>` 避免重复注入
- [x] island 元信息（优先级 / 名称 / 序列化 props）与 `renderToStringAsIsland()`
- [x] `hydrateIslands()` 支持 `eager` / `idle` / `visible` / `interaction` 四档优先级
- [x] `static hydration = 'manual'` + `hydrate()` 实现“先保留 SSR 内容，后接管”
- [x] 组件 HMR：原型热替换 + 同实例重新挂载，保留 signal / props 状态
- [x] Vite 插件在 dev 注入 `import.meta.hot.accept()` 与 HMR 桥接
- [x] 新增 DSD / 部分水合 / HMR 测试

### 23.7 选项求值、SSR 分派、island 与 HMR 深化

- [x] prop 选项改为运行时求值（`static __laniaOptions`），支持表达式/导入/展开
- [x] `observedAttributes` / `reflect` 首轮反射改由运行时按选项推导
- [x] props 解构支持默认值、rest 与嵌套；计算属性名仍报错
- [x] 跨文件 props 类型（相对路径具名导入）静态展开
- [x] `renderComponentToString()` / `renderComponentToStream()` 按 `renderMode` 分派
- [x] light 模式 SSR 不再输出 DSD 模板，样式去重覆盖 light 渲染根
- [x] 编译期 island 标记 `<Child client:visible />` + `ssrRenderIslandSlot()`
- [x] island 宿主自动延后水合，`hydrateIslands()` 只回填声明的 prop
- [x] dev 产物 `__laniaSetup()`：HMR 可补建新增 setup 状态
- [x] dev + HMR 下用 MutationObserver 兜底未声明 attribute
- [x] `hotReload` 选项可关闭 dev setup 产物

### 23.8 验证

- [x] 新增编译边界测试
- [x] 新增运行时原语测试
- [x] 新增编译产物端到端集成测试（解构 / composable / helper / styles / 绑定视图）
- [x] 全量 `vitest run` 通过
- [x] 全 workspace `typecheck` 通过
- [x] 改动文件 ESLint / MarkdownLint 通过
