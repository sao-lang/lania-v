# 过渡与缓存

`Transition`、`TransitionGroup` 和 `KeepAlive` 都是由编译器识别的结构型增强组件。

它们不会引入新的动画引擎，而是把**阶段回调**交给运行时调度：

- `Transition`：单节点出现 / 离开；
- `TransitionGroup`：列表项进入 / 离开 / 移动；
- `KeepAlive`：按 key 缓存子树，保留 DOM 与内部状态。

## `Transition`

```tsx
<Transition
  name="fade"
  enter={(element, context) => {
    element.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 200,
      easing: 'ease-out',
    });
  }}
  leave={(element) => {
    const animation = element.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 150,
    });
    return animation.finished;
  }}
>
  <Panel />
</Transition>
```

Props：

```ts
interface TransitionProps {
  payload?: TransitionPayload;
  name?: string;
  transitionKey?: PropertyKey | null;
  enter?: TransitionLifecycleHook;
  leave?: TransitionLifecycleHook;
  appear?: TransitionLifecycleHook;
  onEnter?: TransitionLifecycleHook;
  onLeave?: TransitionLifecycleHook;
  onAppear?: TransitionLifecycleHook;
  children?: unknown;
}
```

Hook 签名：

```ts
type TransitionLifecycleHook = (
  element: Element,
  context: {
    name?: string;
    phase: 'enter' | 'leave' | 'appear' | 'move';
  }
) => void | Promise<void>;
```

运行时行为：

- `appear`：首次出现；
- `enter`：从不可见变为可见；
- `leave`：从可见变为不可见；
- `transitionKey` 是过渡实例的身份（stateKey），需要在多次渲染间保持稳定；
  不要用它承载“当前是否可见”这类变化值，否则每次渲染都会变成新状态；
- hook 可以返回 `Promise` 或 `Animation`，运行时会等待其完成；
- 返回 `Animation` 时等待 `animation.finished`；
- 如果 hook 触发了新的 CSS 动画，运行时会等待这些动画结束；
  若动画被暂停（例如页面不可见），会按动画自身结束时间兜底，避免离场节点滞留在 DOM；
- `leave` 阶段会延后到下一帧再执行，确保节点仍在文档中；
  页面不可见时 `requestAnimationFrame` 会被暂停，此时运行时退回定时器；
- 多个钩子按 `Promise.allSettled()` 汇合；
- 节点尚未连入文档时，钩子会延迟到插入后再执行。

::: tip 与 CSS 配合
`name` 只是传给 hook 的上下文，运行时不自动生成 `fade-enter-active` 这类 class。你可以在 hook 中手动添加 class，或直接使用 `element.animate()` / `getAnimations()`。
:::

### 常用写法

```tsx
const fade = (element: Element) =>
  element.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: 180,
    easing: 'ease-out',
  }).finished;

<Transition appear={fade} enter={fade}>
  <Card />
</Transition>;
```

## `TransitionGroup`

```tsx
<TransitionGroup
  tag="ul"
  keys={rows().map((row) => row.id)}
  move={(element) => {
    element.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: 160 });
  }}
  leave={(element) => {
    return element.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 120,
    }).finished;
  }}
>
  <Each items={rows()} key={(row) => row.id}>
    {(row) => <li>{row.title}</li>}
  </Each>
</TransitionGroup>
```

Props：

```ts
interface TransitionGroupProps {
  payload?: TransitionPayload;
  name?: string;
  tag?: string;
  groupKey?: PropertyKey | null;
  keys?: readonly PropertyKey[];
  move?: TransitionGroupLifecycleHook;
  leave?: TransitionGroupLifecycleHook;
  enter?: TransitionGroupLifecycleHook;
  appear?: TransitionGroupLifecycleHook;
  onMove?: TransitionGroupLifecycleHook;
  onLeave?: TransitionGroupLifecycleHook;
  onEnter?: TransitionGroupLifecycleHook;
  onAppear?: TransitionGroupLifecycleHook;
  children?: unknown;
}
```

Hook 上下文额外包含：

```ts
interface TransitionGroupHookContext {
  name?: string;
  phase: 'enter' | 'leave' | 'appear' | 'move';
  key: PropertyKey;
  index: number;
  previousIndex?: number;
}
```

行为：

- `tag` 指定包装元素（默认不额外包装）；
- `keys` 显式提供列表 key（编译期会把 `keys` 表达式带进 block payload）；
  不提供时会退回按元素的 `data-key` / `id` / 标签名推断；
- `groupKey` 是这一组过渡实例的身份（stateKey），需要在多次渲染间保持稳定；
- 新项走 `enter`，消失项走 `leave`，位置变化走 `move`；
- 离开中的节点会保留到 `leave` 完成；
- 同一轮的移动会按 DOM 快照计算 `previousIndex` / `index`。

## `KeepAlive`

```tsx
<KeepAlive
  scope="tabs"
  cacheKey={activeTab()}
  max={3}
  include={['detail', 'settings']}
  onActivate={(value, key, reused) => console.log('activate', key, reused)}
  onDeactivate={(value, key) => console.log('deactivate', key)}
  onCache={(value, key) => console.log('cache', key)}
  onEvict={(value, key) => console.log('evict', key)}
>
  <TabPanel tab={activeTab()} />
</KeepAlive>
```

Props：

```ts
interface KeepAliveProps {
  payload?: CachePayload;
  scope?: string;
  cacheKey?: PropertyKey | null;
  include?: readonly string[] | RegExp | null;
  exclude?: readonly string[] | RegExp | null;
  max?: number;
  onActivate?: (
    value: EnhancedRenderable,
    key: string,
    reused: boolean
  ) => void;
  onDeactivate?: (value: EnhancedRenderable, key: string) => void;
  onCache?: (value: EnhancedRenderable, key: string) => void;
  onEvict?: (value: EnhancedRenderable, key: string) => void;
  children?: unknown;
}
```

行为：

- `cacheKey` 是缓存键；为空时组件走普通渲染，不进入缓存；
- `scope` 隔离不同缓存域，默认 `component:default`；
- `include` / `exclude` 按 key 过滤：
  - 数组：精确匹配；
  - 正则：`RegExp.test(key)`；
  - `exclude` 优先于 `include`；
- `max` 控制缓存数量，超出时按 LRU 淘汰；
- 命中缓存时不会重新创建子树，DOM 节点与内部状态都会保留；
- 被淘汰的项会触发 `onEvict`。

### 生命周期

```text
首次进入    → onCache
命中缓存    → onActivate(value, key, reused = true)
切走        → onDeactivate
超限淘汰    → onEvict
```

### 与条件渲染配合

```tsx
<KeepAlive cacheKey={selectedTab()}>
  <When when={selectedTab() === 'profile'} mode="remount">
    <ProfileForm />
  </When>
</KeepAlive>
```

`KeepAlive` 缓存的是整段子树；`When` 的 `mode` 只影响条件分支内部的重建策略。两者可以组合，但不要用 `remount` 去“手动清空” KeepAlive 的缓存。

## 选择建议

| 需求                    | 选择               |
| ----------------------- | ------------------ |
| 单个元素进出动画        | `Transition`       |
| 列表增删 / 重排动画     | `TransitionGroup`  |
| 切换 Tab 时保留表单状态 | `KeepAlive`        |
| 只保留 DOM，不保留状态  | 普通 `When`        |
| 长列表性能              | `Virtual` + `Each` |

## 下一步

- [增强组件 API](/api/enhanced-components)：完整 props 与 hook 类型。
- [状态管理](/guide/state)：用 Signal / Store 驱动过渡。
- [更新链路](/advanced/update-pipeline)：过渡任务与调度器优先级。
