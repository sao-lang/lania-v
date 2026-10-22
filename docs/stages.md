# 版本阶段与历史说明

本文档收口原先分散的阶段文档，只保留当前仍有决策价值的内容：

- `v0.1`：当前已经稳定落地的结论、支持面与风险
- `v0.2`：下一阶段继续收敛的目标与约束
- 历史说明：哪些内容已经降级为背景信息，不再作为当前依据

## 当前应以哪些文档为准

当前 source of truth 统一为：

- `technical-scheme.md`：唯一架构入口
- `runtime-api.md`：运行时 API 与 `FC / TSX` 主路径
- `ssr-hydration.md`：SSR / Hydration 协议与边界
- `plan.md`：执行计划与验收清单

本文件只补充“当前阶段已经收敛到哪里、下一阶段准备继续收什么”。

## `v0.1` 稳定结论

### 主路径

`v0.1` 已形成的主路径是：

```text
TSX
  -> compiler lowering
  -> unified IR
  -> payload / renderPlan / codegen
  -> runtime slot / boundary execution
```

当前稳定共识：

- 编译产物路径是正式语义来源
- `.lania.tsx` 是当前唯一正式输入入口
- runtime JSX 直执行路径仍存在，但只应视为兼容层
- `packages/shared` 中的 registry 与 contract 已成为单一真实来源
- 当前剩余工作更偏测试扩容和兼容面收缩，而不是主协议层缺失

共享来源：

- 注册表：`packages/shared/src/enhanced-registry.ts`
- 协议：`packages/shared/src/enhanced-contract.ts`

### 支持面

| Component                        | 编译主路径 | Runtime JSX  | SSR | Hydration | 备注                                         |
| -------------------------------- | ---------- | ------------ | --- | --------- | -------------------------------------------- |
| `When`                           | Yes        | Compat layer | Yes | Yes       | 结构分支语义由编译器 lowering                |
| `Then` / `Else`                  | Yes        | Compat layer | N/A | N/A       | 仅作为 `When` 的编译期标记                   |
| `Switch` / `Case` / `Default`    | Yes        | Compat layer | Yes | Yes       | `Switch value` 做取值匹配                    |
| `Match`                          | Yes        | Compat layer | Yes | Yes       | 布尔分支，等同 `Case when`                   |
| `Each`                           | Yes        | Compat layer | Yes | Yes       | lower 到列表/slot IR                         |
| `Fragment`                       | Yes        | Compat layer | Yes | Yes       | 语法糖，最终被 flatten                       |
| `Dynamic`                        | Yes        | Compat layer | Yes | Yes       | 动态组件解析进入 IR                          |
| `Teleport`                       | Yes        | Compat layer | Yes | Yes       | 已接入跨容器 SSR / Hydration                 |
| `KeepAlive`                      | Yes        | Compat layer | Yes | Yes       | contract-first，仍在持续收紧兼容面           |
| `Transition` / `TransitionGroup` | Yes        | Compat layer | Yes | Yes       | 已有专用 `TransitionIR` 与共享 host scaffold |
| `LazyLoad`                       | Yes        | Compat layer | Yes | Yes       | 走统一 boundary payload                      |
| `ErrorBoundary`                  | Yes        | Compat layer | Yes | Yes       | 主路径已经共享 boundary host                 |
| `Suspense`                       | Yes        | Compat layer | Yes | Yes       | 支持 fallback、流式 chunk 与恢复             |
| `Await` / `Virtual`              | Yes        | Compat layer | Yes | Yes       | `Virtual` 支持可变行高与双向滚动             |
| `Reach`                          | Yes        | Compat layer | N/A | N/A       | 触底/进入视口哨兵                            |

### 当前可信结论

- `KeepAlive`、`ErrorBoundary`、`TransitionGroup` 已有较强的自动化证据
- `Teleport`、`When`、`Switch`、`Each`、`Dynamic` 已处于可用主路径
- `Suspense` 已具备 fallback、异步 chunk 回填与恢复链路
- SSR / Hydration 已经进入协议化验证阶段，而不是只停留在 demo 可用

### 主要风险

高风险：

1. 编译路径与 direct `jsx-runtime` 直执行路径仍然同时存在
2. 少量 legacy / flat 输入面仍可能泄露到 runtime，尤其是 `KeepAlive` 一类组件
3. `TransitionGroup` 仍需要持续验证宿主差异路径是否保持一致
4. SSR / Hydration 的 marker、payload 和恢复协议非常容易回归

中风险：

1. 增强组件 metadata 字段可能在 compiler / runtime / typecheck 之间漂移
2. boundary 的嵌套 replay / reset / hydrate-after-fallback 仍需要继续补样本

低风险：

1. 非编译路径下的旧式 TSX authoring 仍可能误用历史语法
2. 文档如果继续把兼容层写成主路径，会重新制造双轨认知

## `v0.2` 收敛目标

### 设计目标

`v0.2` 聚焦 `FC / .lania.tsx` 主线的继续收敛，不再讨论已经删除的旧输入路线。

当前目标主要有四类：

1. 生命周期最终只保留少数高价值能力
2. TSX 主线的对象型 props 继续稳定
3. 编译器与运行时遵守更严格的边界
4. 文档、测试和 playground 都围绕统一主路径扩样

### 当前共识

- `.lania.tsx` 是当前唯一正式输入入口
- 生命周期只保留 `onMount`、`onCleanup`、`onUpdated` 三个 hooks
- `.lania.tsx` 编译失败会走专门的错误对象与 Vite overlay 定位链路
- `createRoot()` 是轻量挂载器，只接收已经可渲染的值
- FC 运行时上下文桥接已收敛到显式 scope，不再依赖旧的全局 host bridge

### 设计原则

- 少而稳：公开 API 以少数核心能力为主，不暴露过细阶段
- 编译优先：优先在编译阶段把对象型 props 降级为既有节点与 slot / updater 产物
- 可静态分析：对象型 props 尽量保持固定 key、对象字面量和可推导结构
- 安全默认值：`html` 是显式原始 HTML 写入能力，不默认承担运行时消毒职责
- 单主线：不再为旧输入路线维护并行语义解释

### 生命周期方案

`FC` 在 `v0.2` 只保留以下 3 个 hooks：

- `onMount`
- `onCleanup`
- `onUpdated`

对应语义：

| Hook        | 触发时机                     | 入参           | 说明                                   |
| ----------- | ---------------------------- | -------------- | -------------------------------------- |
| `onMount`   | 组件首次挂载并完成首屏建立后 | 无             | 用于启动副作用、读取 DOM、注册外部资源 |
| `onCleanup` | 组件销毁前                   | 无             | 用于解绑、释放资源、取消订阅           |
| `onUpdated` | 每次更新完成后               | `changedProps` | 用于读取新 DOM、同步第三方状态         |

额外约束：

- `onError` 不再属于 `FC` 生命周期能力，统一交给 `ErrorBoundary`
- 宿主级生命周期继续留在宿主层，不回流为普通 `FC` API
- 旧别名如果仍被识别，也只作为过渡兼容，不继续扩展

### FC 指令对象主线

`v0.2` 中，`FC` 主路径重点收敛在以下能力：

- 事件修饰符
- `model`
- `class`
- `style`
- `use`
- `html`

核心约束：

- 事件对象型写法必须存在 `handler`
- `model` 的 `target` 和 `source` 只能二选一
- `className` 是文档主路径，`class` 只作为兼容别名
- `style` 统一支持字符串、对象、数组归一化
- `use` 的 key 必须是静态字符串
- `html` 与普通 children 互斥

### 编译与运行时方向

目标链路：

```text
FC object props
  -> normalize object bindings
  -> EventNode / DirectiveNode / HtmlBinding node
  -> Component IR
  -> slot allocation / updater generation
  -> runtime slot system
```

编译期限制：

- 只支持对象字面量
- key 必须静态
- 不支持 spread
- 不支持计算属性名

运行时优先复用：

- 事件 slot
- `model` / `use` / `html` 相关 slot 与事件基础设施
- 微任务调度
- slot dirty tracking
- updater generation

### 诊断规则

建议继续保留以下诊断方向：

- 旧生命周期 hook 给出替代项
- 非对象字面量的对象型 props 报错
- `model` 同时出现 `target` 与 `source` 报错
- 非键盘事件使用 `modifiers.keys` / `modifiers.system` 报错
- `use` 的 key 不是静态字符串时报错
- `html` 与 children 同时存在时报错

### 实施顺序

1. 生命周期继续只保留 3 个 hooks
2. 稳定 `html`、`use`、`model` 的编译与运行时行为
3. 稳定 `class` / `style` 归一化与对象型事件 props
4. 持续补诊断、测试与 playground 示例

## 历史说明

更早的宽口径设计档案已降级为历史背景，不再作为当前实现、验收或文档编写依据。

如果需要追溯：

- 先看当前 `technical-scheme.md`、`runtime-api.md`、`plan.md`
- 再回到 Git 历史查看更早阶段的设计演化
