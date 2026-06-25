# SSR / Hydration 文档

本文档描述 `lania-v` 当前已经落地的 SSR / Hydration 能力。

## 当前定位

当前实现已经覆盖基础模板 SSR、增强边界协议、Teleport 跨容器 SSR 和 Suspense 流式回填：

- 支持 slot marker
- 支持增强边界 marker 与元信息序列化
- 支持客户端 hydration 复用现有 DOM
- 支持恢复 slot table 和运行时 updater 绑定
- 支持 Teleport 目标容器输出与 hydration 对齐
- 支持 Suspense 流式 chunk 输出与客户端 patch 回填

## 服务端输出

服务端输出基于静态模板和 slot 标记：

- 文本 slot 使用文本 SSR 输出
- 条件、列表、dynamic、teleport 使用 block slot 标记
- 增强组件边界使用独立 boundary marker
- 条件分支当前优先复用静态模板信息

`Teleport`、`Suspense` 与增强边界会带元信息：

- `Teleport`: `to`
- `Suspense`: `boundaryId / suspenseKey / status`
- 增强边界：`component + key-like metadata`
- `if`: `strategy: "static-template"`

## 关键 API

### `ssrEvaluate()`

在服务端上下文里求值表达式。

### `ssrEscapeHtml()`

输出 HTML 安全字符串。

### `ssrRenderTextSlot()`

为文本 slot 生成 SSR 结果。

### `ssrRenderBlockSlot()`

为条件、列表、dynamic、teleport 生成 block slot 和 marker。

### `ssrRenderEnhancedBoundary()`

为 `Suspense / ErrorBoundary / KeepAlive / LazyLoad / Transition /
TransitionGroup` 输出 SSR 边界 marker。

### `ssrRenderTeleportSlot()` / `ssrRenderTeleportContainer()`

把 Teleport 主树占位和目标容器内容拆开输出。

### `ssrRenderSuspenseBoundary()` / `ssrDrainSuspenseChunks()` / `applySSRChunk()`

用于 Suspense 的流式 fallback、异步 chunk 回填和客户端 patch 应用。

## Hydration

客户端 hydration 会执行以下步骤：

1. 挂载静态模板或识别现有 DOM
2. 扫描 hydration markers
3. 重建 slot table
4. 扫描增强边界与边界元信息
5. 恢复 runtime updater 绑定
6. 复用已有 DOM，避免重复创建节点
7. Teleport 从目标容器恢复已有节点

## 运行时结构

`mountStaticTemplate()` 返回：

- `nodes`
- `hydrated`
- `hydrationSlots`
- `hydrationBoundaries`

每个 hydration slot 会记录：

- `index`
- `start`
- `end`
- `contentNodes`
- `kind`
- `metadata`

## 当前支持范围

- 文本内容 SSR
- 属性序列化
- 条件分支基础版 SSR
- 列表 slot marker
- dynamic / teleport 边界 marker
- 增强组件 SSR 边界元信息
- Teleport 跨容器 SSR 输出
- Suspense 流式 fallback + chunk 回填
- 客户端 hydration 复用 DOM

## 当前边界

- 条件分支 SSR 仍然采用静态模板策略，不是更激进的分支级代码生成方案。
- Suspense 的客户端恢复协议已具备，但复杂异步组件树仍建议优先参考测试路径验收。
