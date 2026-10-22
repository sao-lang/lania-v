# 增强组件文档

本文档描述当前已经落地的增强组件与使用方式。

补充说明：

- FC / 直接 TSX 路径现在支持两种输入面：
- 推荐主路径是直接写组件 props，例如 `cacheKey`、`transitionKey`、`lazyKey`、`suspenseKey`。
- `payload` 仍保留给编译产物和底层调试场景，且在同一组件上优先级高于本地友好 props。

## 条件与列表

### `When`

```tsx
<When value={this.visible} fallback={<p>Hidden</p>}>
  <p>Visible</p>
</When>
```

`value` 为真时渲染 `children`，否则渲染 `fallback`（也可以写成 `<Else>` 子节点）。

### `Switch` / `Case` / `Match` / `Default`

`Switch` 有两种模式，用来替代嵌套三元表达式。

**取值匹配**：给 `Switch` 传 `value`，`<Case when>` 写期望值，命中条件是严格相等。

```tsx
<Switch value={this.mode}>
  <Case when="register">已有账号？</Case>
  <Case when="forgot">想起密码了？</Case>
  <Default>还没有账号？</Default>
</Switch>
```

**布尔分支**：不传 `Switch value` 时，每个分支独立判断条件。`<Case when>` 与
`<Match value>` 语义等价，`<Match>` 只是让"这是一条布尔条件"更直白。

```tsx
<Switch>
  <Match value={this.loading}>加载中…</Match>
  <Match value={this.error}>加载失败</Match>
  <Default>列表内容</Default>
</Switch>
```

### `Each`

```tsx
<Each value={this.items} fallback={<p>Empty</p>}>
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

### `Await`

等待一个 Promise 并渲染结果，自带 fallback / error 分支。

```tsx
<Await
  value={() => this.userPromise()}
  fallback={<p>Loading</p>}
  delay={120}
  error={(error) => <p>{String(error)}</p>}
  onResolve={(user) => this.log(user)}
>
  {(user) => <p>{user.name}</p>}
</Await>
```

- `value`：Promise、返回 Promise 的函数，或同步值（同步值直接渲染，不进入 fallback）。
- `fallback`：支持节点或 `() => node`；配合 `delay` 可在等待超过 `delay` 毫秒后才显示。
- `error`：支持节点或 `(error) => node`，缺省时渲染错误的字符串形式。
- `children`：支持节点或 `(resolved) => node`。
- 宿主是 `display: contents` 的 `span`，不参与布局。
- 已 settle 后的迟到回调不会再影响结果；未挂载的宿主同样会更新，方便先构造后插入。

### `Virtual`

窗口化列表，只渲染可视区 + `overscan` 的行。支持固定行高、逐项预知高度和
未知行高（估算后实测）三种模式。

```tsx
// 固定行高：零测量成本，最快
<Virtual value={this.rows()} itemHeight={24} height={240} overscan={3}>
  {(row, index) => <div>{index}: {row.title}</div>}
</Virtual>

// 未知行高：估算器占位，渲染后实测覆盖，并做滚动锚定
<Virtual value={this.rows()} itemHeight={() => 40} height={240}>
  {(row) => <Card row={row} />}
</Virtual>
```

#### 行高

`itemHeight` 支持三态：

| 形态                | 行为                                               |
| ------------------- | -------------------------------------------------- |
| `number`            | 固定行高，不测量，行高直接写进内联样式             |
| `number[]`          | 逐项预知高度，首帧即可正确定位，省掉测量抖动       |
| `(index) => number` | 估算器；未测量的行用估算值占位，渲染后用实测值覆盖 |

可变行高时，前缀偏移由 Fenwick 树维护，滚动定位是 `O(log n)`。实测值写入后会
按「可视区首行」做**滚动锚定**：首行之前的行变高/变矮时同步补偿 `scrollTop`，
用户看到的第一行不会跳走。

#### 双向虚拟滚动

同时提供 `width` 与 `itemWidth` 时启用横向虚拟化，否则只做纵向。

```tsx
<Virtual
  value={this.cells()}
  itemHeight={32}
  height={240}
  width={320}
  itemWidth={120}
>
  {(cell) => <span>{cell.label}</span>}
</Virtual>
```

#### 分组头

`groupBy` 返回分组名时自动插入分组头行，并用 sticky 层把当前分组的头钉在顶部。

```tsx
<Virtual
  value={this.contacts()}
  itemHeight={44}
  headerHeight={28}
  height={320}
  groupBy={(contact) => contact.initial}
  header={(group) => <strong>{group}</strong>}
>
  {(contact) => <span>{contact.name}</span>}
</Virtual>
```

#### 空态与增量加载

- `fallback`：`value` 为空时渲染，支持节点或 `() => node`。
- `onEndReached`：滚动到距底部小于 `endReachedThreshold`（默认 160）时触发。
- `hasMore`：为 `true` 时允许反复触发；为 `false` 时判定已到底，只触发一次。

#### 命令式 API

渲染出的宿主元素上挂有：

- `scrollToIndex(index, { align })`：`align` 取 `'start' | 'center' | 'end'`。
- `scrollToOffset(offset)`：直接定位到纵向偏移。
- `measure()`：强制重测当前窗口内的行（例如图片加载完成后）。

声明式场景也可以直接传 `scrollTo`：数字表示偏移，`'#12'` 表示第 12 项。

#### 其他 props

- `key`：结果写到行的 `data-key` 上，便于调试与测试。
- `onScroll({ scrollTop, scrollLeft, startIndex, endIndex, direction })`：窗口与方向快照。
- `onResize(rowIndex, { height, width })`：行实测尺寸回调。
- `tag`：宿主标签名，默认 `div`。

### `Reach`

触底 / 进入视口哨兵，用于无限滚动、懒加载与曝光埋点。

```tsx
// 无限滚动：盯滚动容器底部
<Reach root="#list" rootMargin="240px" hasMore={hasMore.value} onReach={loadMore}>
  <p>加载中…</p>
</Reach>

// 懒加载 / 曝光：盯哨兵自身进入视口
<Reach mode="viewport" once onReach={track}>
  <Card />
</Reach>
```

- `mode`：`'root'`（默认）盯滚动容器底部；`'viewport'` 盯哨兵进入视口。
- `root`：CSS 选择器、元素，或 `null` 表示浏览器视口；省略时自动向上查找可滚动祖先。
- `rootMargin`：提前量，`'240px'` 表示距底部还有 240px 就触发。
- `once`：只触发一次。
- 离开底部区域后会自动重新武装，支持「加载 → 继续滚 → 再加载」。
- 未提供 `root` 且找不到滚动祖先时，退回视口判定。

## 当前边界

- 增强组件第一版运行时主路径已可用。
- 增强组件 SSR 边界元信息、Teleport 跨容器 SSR、Suspense 流式回填已落地。
- `Virtual` 的行尺寸测量依赖 `ResizeObserver` 与真实布局；SSR 首屏按估算值输出完整高度占位。
- 复杂组合场景建议优先参考测试与 playground。
