# 增强组件文档

本文档描述当前已经落地的增强组件与使用方式。

补充说明：

- FC / 直接 TSX 路径现在支持两种输入面：
- 推荐主路径是直接写组件 props，例如 `cacheKey`、`transitionKey`、`lazyKey`、`suspenseKey`。
- `payload` 仍保留给编译产物和底层调试场景，且在同一组件上优先级高于本地友好 props。

## 条件与列表

### `When`

```tsx
<When when={this.visible} fallback={<p>Hidden</p>}>
  <p>Visible</p>
</When>
```

### `Each`

```tsx
<Each items={this.items} fallback={<p>Empty</p>}>
  {(item, index) => <li data-index={index}>{item}</li>}
</Each>
```

## 结构类

### `Fragment`

返回多节点内容，不额外包裹宿主节点。

### `Dynamic`

```tsx
<Dynamic is={this.resolveTag()} props={{ title: this.title() }} />
```

也支持直接传 `component`。

### `Teleport`

```tsx
<Teleport to="#portal-root">
  <div class="modal">Modal</div>
</Teleport>
```

当前 SSR 已支持：

- 主树占位 marker 与目标容器映射协议
- 服务端跨容器输出
- 客户端 Teleport hydration 对齐

## 缓存与切换

### `KeepAlive`

支持：

- `include`
- `exclude`
- `max`
- `cacheKey`
- `scope`
- `onActivate`
- `onDeactivate`
- `onCache`
- `onEvict`

当前实现说明：

- 组件路径的 `KeepAlive` 已按实例语义处理 cache hit：same-key active entry 会走实例 `update`，而不是继续停留在“直接返回旧可渲染值”的语义。
- 组件路径的 same-key 节点替换已接入最小共享 `component-side instance 对象 + mounted-instance record + host target resolver + host adapter + host commit controller`：record 会显式持有 `nodes / hostTarget / mounted`，component-side instance 只处理结构节点队列与 `commit / detach / destroy`，`EnhancedRenderable <-> nodes` 转换已开始退回外层边界适配；slot 与组件路径现在也已开始共用稍强一点的 `KeepAliveMountedSurface` 适配层，至少覆盖 `readNodes / readHostTarget / isMounted / update / activate / detach / destroy`，但组件路径仍未像 slot 路径那样具备更完整的 mounted binding / mounted-instance 底座。
- slot 路径上的 block payload 现已显式按“contract source 优先、legacy flat source 仅兜底”解析，说明 `payload.cache / payload.metadata` 已成为正式输入面，旧 flat fields 只剩兼容层语义。
- block payload 内部的正式来源也继续收严了：`payload.cache` 只承接 `scope / key / include / exclude / max`，`payload.metadata` 只承接 hooks；一旦 contract source 存在，legacy flat `scope / cacheKey / max / include / exclude / hooks` 就不再参与同层混合。
- 这层差异现在不再只藏在 helper 内部优先级里：共享解析结果已经显式暴露 `contract / legacy` runtime source kind，slot 主流程可以直接知道当前走的是正式输入还是 compat fallback。
- slot 路径与组件路径已共用 `KeepAliveInstance` 生命周期骨架；slot 侧 cached / uncached 宿主提交也开始通过正式的 `KeepAliveHostAdapter` 收口，target 解析流程中的 redirect/context 候选选择与 repair/fallback 已进入共享 `KeepAliveHostTargetResolver` / `resolveKeepAliveHostTarget()` 骨架。
- 但两条路径目前还没有完全收敛成同一套底层实例实现，`parent / anchor` 解析与最终 target 选择的具体实现仍保留在 slot 本地的薄接线层。

## 动画与延迟

### `Transition`

支持 `appear / enter / leave` 生命周期 hook。

### `TransitionGroup`

支持 `appear / enter / leave / move` hook，并带 key/index 上下文。

#### 运行时约束

`TransitionGroup` 不依赖通用 diff，也不建立运行时依赖图；但在和 `Each` / `ForSlot` 组合时，仍然需要稳定的结构 owner 协议。

- `ForSlot` 是 keyed block 的真实 DOM 提交者。
- `TransitionGroup` 是动画 owner，负责接管 removed block，并在 leave 完成后 finalize removal。
- 两者通过 domHost owner handoff 协议协作，而不是通过事后扫描 DOM 做补救。

这意味着下面两个约束必须成立：

- domHost 模式必须在同一个组件生命周期内保持稳定，不能在相邻 render 中在 domHost/plain 两套模型之间切换。
- `domHostAnchor` / `domHostLeaveAnchor` 必须稳定存在于同一个容器中，且顺序稳定；否则 removed block 的 handoff、move 和 leave finalize 都会失去正确目标。

这条约束不改变框架的核心方向：

- 依赖仍然在编译期确定。
- 运行时仍然不建立通用依赖图。
- 更新路径仍然不走通用 diff。

但它补充了一条同样重要的前提：

- 结构型增强组件的 owner 与挂载拓扑必须稳定。

### `LazyLoad`

支持：

- `fallback`
- `rootMargin`
- `once`
- `observe`
- `lazyKey`
- `target`
- `onVisibleChange`

## 容错与异步

### `ErrorBoundary`

支持错误 fallback、reset 和回调 hook。

### `Suspense`

支持：

- `fallback`
- `suspenseKey`
- `onPending`
- `onResolve`
- `onReject`

当前 `Suspense` 已支持：

- `fallback` 首包输出
- 服务端流式 chunk 收集
- 异步 chunk 回填协议
- 客户端 `applySSRChunk()` 协同恢复

## 当前边界

- 增强组件第一版运行时主路径已可用。
- 增强组件 SSR 边界元信息、Teleport 跨容器 SSR、Suspense 流式回填已落地。
- 复杂组合场景建议优先参考测试与 playground。
