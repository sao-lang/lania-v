# 增强组件 API

增强组件是 `lania-v` 在 TSX 之上提供的一组**结构化能力**。它们不是普通函数组件：

- 编译器会识别标签名；
- 编译器会把它们下沉为对应的 IR；
- 运行时通过 block payload 恢复语义；
- SSR / hydration 也依赖同一套协议。

```tsx
import {
  When,
  Then,
  Else,
  Switch,
  Case,
  Default,
  Each,
  Dynamic,
  Slot,
  Fragment,
  Teleport,
  KeepAlive,
  Transition,
  TransitionGroup,
  Suspense,
  ErrorBoundary,
  LazyLoad,
  Await,
  Virtual,
} from '@lania-v/runtime/advanced';
```

## 公共类型

```ts
type EnhancedRenderable =
  | Node
  | string
  | number
  | boolean
  | null
  | undefined
  | (() => EnhancedRenderable)
  | readonly EnhancedRenderable[];

interface EnhancedComponentDefinition<
  TName extends string,
  TProps extends object,
  TResult = unknown,
> {
  (props: TProps): TResult;
  readonly displayName: TName;
  readonly [ENHANCED_COMPONENT_KIND]: true;
}

const ENHANCED_COMPONENT_KIND = Symbol.for('lania.enhanced-component');
```

判断一个值是否是增强组件：

```ts
isEnhancedDef(value);
```

## `When`

### 用途

根据布尔条件切换内容，并可选保留或重建分支状态。

```tsx
<When when={visible()} fallback={<p>hidden</p>} mode="retain">
  <Panel />
</When>
```

### Props

```ts
interface WhenProps {
  when: boolean;
  fallback?: EnhancedRenderable;
  mode?: 'retain' | 'remount';
  children?: unknown;
}
```

| Prop       | 说明                                             |
| ---------- | ------------------------------------------------ |
| `when`     | 条件                                             |
| `fallback` | 条件为假时渲染                                   |
| `mode`     | `remount`（默认）销毁重建；`retain` 保留分支节点 |
| `children` | 条件为真时渲染                                   |

### `mode` 的差异

```tsx
// 保留输入框内容、滚动位置、子组件状态
<When when={tab() === 'form'} mode="retain">
  <Form />
</When>

// 每次进入都重新创建
<When when={tab() === 'form'} mode="remount">
  <Form />
</When>
```

需要重置内部状态时用 `remount`；需要保留时用 `retain`。

### `Then` / `Else`

```tsx
<When when={ready()}>
  <Then>
    <Result />
  </Then>
  <Else>
    <Skeleton />
  </Else>
</When>
```

约束：只能作为 `<When>` 的**直接子节点**。

它们本身不产生运行时节点，只帮助编译器建立分支结构。

## `Switch` / `Case` / `Default`

```tsx
<Switch mode="retain">
  <Case when={status() === 'loading'}>
    <Spinner />
  </Case>
  <Case when={status() === 'error'}>
    <ErrorView />
  </Case>
  <Default>
    <Content />
  </Default>
</Switch>
```

### Props

```ts
interface SwitchProps {
  mode?: 'retain' | 'remount';
  children?: unknown;
}

interface CaseProps {
  when: boolean;
  children?: unknown;
}

interface DefaultProps {
  children?: unknown;
}
```

### 语义

- 按顺序检查 `Case`；
- 第一个为真的 `Case` 生效；
- 都不匹配时渲染 `Default`；
- `Case` / `Default` 只能作为 `<Switch>` 的直接子节点；
- 编译器会把 `Switch` lowering 为嵌套 `IfIR`。

## `Each`

### 用途

渲染列表，并在 `items` 变化时做 keyed 协调。

```tsx
<Each items={todos()} key={(item) => item.id} fallback={<p>No todos</p>}>
  {(item, index) => (
    <div>
      <span>{index + 1}.</span>
      <span>{item.text}</span>
    </div>
  )}
</Each>
```

### Props

```ts
interface EachProps<T> {
  items: readonly T[] | null | undefined;
  key?: (item: T, index: number) => PropertyKey;
  fallback?: EnhancedRenderable;
  children:
    ((item: T, index: number) => EnhancedRenderable) | EnhancedRenderable;
}
```

| Prop       | 说明                                              |
| ---------- | ------------------------------------------------- |
| `items`    | 列表数据；空 / `null` / `undefined` 渲染 fallback |
| `key`      | 唯一 key；提供时走 keyed 协调                     |
| `fallback` | 空列表内容                                        |
| `children` | 函数时按 `(item, index)` 调用                     |

### keyed 与 unkeyed

**keyed**：

```tsx
<Each items={rows()} key={(row) => row.id}>
  {(row) => <Row row={row} />}
</Each>
```

- 按 key 建立旧节点索引；
- 只创建新增项；
- 移动复用项；
- 移除消失项。

**unkeyed**：

```tsx
<Each items={rows()}>{(row) => <Row row={row} />}</Each>
```

- 按下标协调；
- 插入 / 删除中间项时，后续项的内容会重新写入；
- 适合纯静态列表。

### 选择 key 的原则

- 稳定；
- 唯一；
- 不随顺序变化。

不要用数组下标作为 key，除非列表只追加。

## `Dynamic`

### 用途

在运行时决定标签名或组件。

```tsx
<Dynamic is={tag()} fallback={<span>unknown</span>}>
  content
</Dynamic>

<Dynamic
  component={Widget}
  props={{ title: title() }}
  fallback={<span>no widget</span>}
/>
```

### Props

```ts
interface DynamicProps {
  is?: unknown;
  component?: unknown;
  props?: Record<string, unknown>;
  fallback?: EnhancedRenderable;
  children?: unknown;
}
```

| Prop        | 说明           |
| ----------- | -------------- |
| `is`        | 标签名或组件   |
| `component` | 组件引用       |
| `props`     | 传给组件的属性 |
| `fallback`  | 无法解析时渲染 |

- `is` 与 `component` 二选一；
- `props` 只在组件路径使用；
- 无法解析目标时渲染 fallback。

## `Slot`

`Slot` 读取父组件传入的默认槽 / 具名槽：

```tsx
<Slot name="header" fallback={<h2>默认标题</h2>} />
<Slot args={item} fallback={<span>empty</span>} />
```

::: warning 适用范围
`Slot` 读取当前 runtime scope 的 `slotContent`，面向运行时 JSX 路径（`jsx(Child, { children })`）。
`.lania.tsx` 编译组件内没有这份 scope，请使用 `bindSlots()`；见 [插槽](/guide/slots#编译组件与运行时-jsx)。
:::

### Props

```ts
interface SlotProps {
  name?: string;
  fallback?: EnhancedRenderable;
  /** 传给函数型 slot 的参数；数组会按位置展开。 */
  args?: unknown;
  children?: unknown;
}
```

### Scoped slot

```tsx
// 父组件（运行时 JSX）
<Child>{(item: Item) => <Row item={item} />}</Child>;

// 子组件
<Slot args={item} />;
```

当插槽内容是函数时，`args` 会作为参数传入。

## `Fragment`

```tsx
<Fragment>
  <dt>{term()}</dt>
  <dd>{definition()}</dd>
</Fragment>
```

- 不产生额外节点；
- 只用于组合多个根；
- 也常用于条件分支中返回多个节点。

```ts
interface FragmentProps {
  children?: unknown;
}
```

## `Teleport`

### 用途

把子树渲染到指定容器。

```tsx
<Teleport to="#portal-root">
  <div className="toast">saved</div>
</Teleport>
```

### Props

```ts
interface TeleportProps {
  to: string | Element | null | undefined;
  children?: unknown;
}
```

| `to`                 | 行为                         |
| -------------------- | ---------------------------- |
| 选择器字符串         | `document.querySelector(to)` |
| `Element`            | 直接使用                     |
| `null` / `undefined` | 不渲染                       |

### SSR / hydration

- SSR 输出 teleport 容器 marker；
- 客户端 hydration 时按 marker 重新接管；
- 目标容器必须在水合时已经存在。

## `KeepAlive`

### 用途

按 key 缓存子树，保留 DOM 与内部状态。

```tsx
<KeepAlive
  scope="tabs"
  cacheKey={activeTab()}
  max={3}
  include={['detail', 'settings']}
  exclude={/^temp-/}
  onActivate={(value, key, reused) => console.log('activate', key, reused)}
  onDeactivate={(value, key) => console.log('deactivate', key)}
  onCache={(value, key) => console.log('cache', key)}
  onEvict={(value, key) => console.log('evict', key)}
>
  <TabPanel tab={activeTab()} />
</KeepAlive>
```

### Props

```ts
type KeepAliveKeyPattern = readonly string[] | RegExp | null | undefined;

interface KeepAliveProps {
  payload?: CachePayload;
  scope?: string;
  cacheKey?: PropertyKey | null;
  include?: KeepAliveKeyPattern;
  exclude?: KeepAliveKeyPattern;
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

### 语义

| Prop       | 说明                                 |
| ---------- | ------------------------------------ |
| `cacheKey` | 缓存键；为空时走普通渲染             |
| `scope`    | 隔离缓存域，默认 `component:default` |
| `include`  | 数组精确匹配 / 正则 `test`           |
| `exclude`  | 优先于 include                       |
| `max`      | 最大缓存数，超出按 LRU 淘汰          |

### 生命周期顺序

```text
首次进入   → onCache → onActivate(value, key, reused = false)
命中缓存   → onActivate(value, key, reused = true)
切走       → onDeactivate
超限淘汰   → onEvict
```

### 与 `When` 配合

```tsx
<KeepAlive cacheKey={selectedTab()}>
  <When when={selectedTab() === 'profile'}>
    <ProfileForm />
  </When>
</KeepAlive>
```

`KeepAlive` 缓存整段子树；`When` 的 `mode` 只影响条件分支内部。

## `Transition`

### 用途

单节点出现 / 离开的过渡钩子。

```tsx
<Transition
  name="fade"
  appear={(element) =>
    element.animate([{ opacity: 0 }, { opacity: 1 }], 180).finished
  }
  enter={(element) =>
    element.animate([{ opacity: 0 }, { opacity: 1 }], 180).finished
  }
  leave={(element) =>
    element.animate([{ opacity: 1 }, { opacity: 0 }], 150).finished
  }
>
  <Panel />
</Transition>
```

### Props

```ts
interface TransitionHookContext {
  name?: string;
  phase: 'enter' | 'leave' | 'appear' | 'move';
}

type TransitionLifecycleHook = (
  element: Element,
  context: TransitionHookContext
) => void | Promise<void>;

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

### 阶段

| 阶段     | 触发             |
| -------- | ---------------- |
| `appear` | 首次出现         |
| `enter`  | 从不可见变为可见 |
| `leave`  | 从可见变为不可见 |

### hook 返回值

- `void`：立即完成；
- `Promise`：等待 resolve；
- `Animation`：等待 `animation.finished`（动画被暂停时按 `endTime` 兜底，避免节点滞留）；
- hook 中启动的新 CSS 动画：运行时会等待这些动画结束。

### 注意

- `name` 只是传给 hook 的上下文；
- `transitionKey` 是**过渡实例的身份**（stateKey），必须在多次渲染之间保持稳定；
  用它承载“当前是否可见”之类的变化值会让每次渲染都变成新状态，`leave` / `enter` 不会触发；
- 运行时不自动生成 `fade-enter-active` 等 class；
- `leave` 会在下一帧执行，确保节点仍在文档中；页面不可见时 `requestAnimationFrame` 会被浏览器暂停，
  运行时此时退回定时器，保证离场 hook 仍会执行；
- 离场快照会在 `leave` 完成后移除；同一 `stateKey` 不要在多处复用，否则多个过渡实例会互相覆盖状态；
- 节点尚未连接时，hook 会延迟到插入后执行。

## `TransitionGroup`

### 用途

列表项的进入 / 离开 / 移动过渡。

```tsx
<TransitionGroup
  tag="ul"
  keys={rows().map((row) => row.id)}
  move={(element) => element.animate([{ opacity: 0.6 }, { opacity: 1 }], 160)}
  leave={(element) =>
    element.animate([{ opacity: 1 }, { opacity: 0 }], 120).finished
  }
>
  <Each items={rows()} key={(row) => row.id}>
    {(row) => <li>{row.title}</li>}
  </Each>
</TransitionGroup>
```

### Props

```ts
interface TransitionGroupHookContext extends TransitionHookContext {
  key: PropertyKey;
  index: number;
  previousIndex?: number;
}

type TransitionGroupLifecycleHook = (
  element: Element,
  context: TransitionGroupHookContext
) => void | Promise<void>;

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

### 语义

- `tag` 指定包装元素；
- `keys` 显式提供列表 key；
- 新项走 `enter`；
- 消失项走 `leave`；
- 位置变化走 `move`；
- 离开中的节点保留到 `leave` 完成；
- `context` 提供 `key` / `index` / `previousIndex`；
- `keys` 必须与列表条目的稳定 key 一致；不传时会退回按元素的 `data-key` / `id` / 标签名推断；
- `groupKey` 是这一组过渡实例的身份（stateKey），需要保持稳定。

## `Suspense`

### 用途

捕获子树 `throw` 出来的 Promise，显示 fallback，并在 resolve 后重放。

```tsx
<Suspense
  fallback={<Spinner />}
  onPending={(promise) => console.log('pending')}
  onResolve={() => console.log('resolved')}
  onReject={(error) => console.error(error)}
>
  <LazyPanel />
</Suspense>
```

### Props

```ts
interface SuspenseProps {
  fallback?: EnhancedRenderable;
  onPending?: (promise: Promise<unknown>) => void;
  onResolve?: () => void;
  onReject?: (error: unknown) => void;
  payload?: BoundaryPayload;
  suspenseKey?: PropertyKey | null;
  children?: unknown;
}
```

### 执行流程

1. 渲染 children；
2. 抛出 thenable → 记录 pending，渲染 fallback；
3. Promise resolve → 重放 children；
4. Promise reject → 记录错误，调用 `onReject`；
5. 非 Promise 错误交给上层 `ErrorBoundary`。

### 常见 Promise 来源

```ts
const LazyPanel = lazy(() => import('./LazyPanel.lania.tsx'));
```

`lazy()` 在未加载完成时会 `throw` 加载 Promise。

## `ErrorBoundary`

### 用途

捕获子树渲染期间的**同步错误**。

```tsx
<ErrorBoundary
  fallback={(error, reset) => (
    <div>
      <p>出错了：{String(error)}</p>
      <button onClick={reset}>重试</button>
    </div>
  )}
  onError={(error) => console.error(error)}
  onReset={() => console.log('reset')}
>
  <MaybeBroken />
</ErrorBoundary>
```

### Props

```ts
interface ErrorBoundaryProps {
  fallback?:
    | EnhancedRenderable
    | ((error: unknown, reset: () => void) => EnhancedRenderable);
  onError?: (error: unknown) => void;
  onReset?: () => void;
  payload?: BoundaryPayload;
  boundaryKey?: PropertyKey | null;
  children?: unknown;
}
```

### 语义

- 捕获 children 渲染错误；
- 渲染 `fallback(error, reset)`；
- `reset()` 清空错误；
- 只有确实从错误态复位成功才调用 `onReset`；
- 重置后会重放 children。

### 不捕获什么

- 事件处理器中的错误；
- 异步回调中的错误；
- `setTimeout` / Promise 中的错误。

这些需要业务自己处理，或交给 `Suspense` / 上层逻辑。

## `LazyLoad`

### 用途

内容进入视口后再渲染。

```tsx
<LazyLoad
  fallback={<Skeleton />}
  rootMargin="200px"
  once
  onVisibleChange={(visible) => console.log('visible', visible)}
>
  <HeavyChart />
</LazyLoad>
```

### Props

```ts
interface LazyLoadProps {
  fallback?: EnhancedRenderable;
  target?: Element | null;
  onVisibleChange?: (visible: boolean) => void;
  payload?: BoundaryPayload;
  lazyKey?: PropertyKey | null;
  rootMargin?: string;
  once?: boolean;
  observe?: boolean;
  children?: unknown;
}
```

### 语义

- 使用 `IntersectionObserver`；
- 观察 `target` 或首个实际渲染元素；
- 不可见时渲染 fallback；
- fallback 中插入 sentinel 作为观察锚点；
- `once` 为真时首次可见后停止观察；
- 环境不支持 `IntersectionObserver` 时直接渲染 children。

## `Await`

### 用途

轻量 Promise 渲染器，不依赖 boundary 协议。

```tsx
<Await
  value={fetchProfile()}
  delay={200}
  fallback={<Skeleton />}
  error={(reason) => <p>失败：{String(reason)}</p>}
  onResolve={(profile) => console.log(profile)}
>
  {(profile) => <ProfileCard profile={profile} />}
</Await>
```

### Props

```ts
interface AwaitProps<T = unknown> {
  value: Promise<T> | (() => Promise<T> | T) | T;
  fallback?: EnhancedRenderable | (() => EnhancedRenderable);
  error?: EnhancedRenderable | ((error: unknown) => EnhancedRenderable);
  delay?: number;
  onResolve?: (value: T) => void;
  onReject?: (error: unknown) => void;
  children?: unknown;
}
```

### 语义

- `value` 是函数时先调用；
- 不是 Promise → 同步渲染；
- 是 Promise → 渲染 fallback（`delay > 0` 时延迟显示）；
- resolve → `children(value)` 或 `value`；
- reject → `error(error)` 或 `String(error)`；
- 不 `throw` Promise，因此不需要外层 `Suspense`。

## `Virtual`

### 用途

固定行高的窗口化列表。

```tsx
<Virtual
  items={rows()}
  itemHeight={32}
  height={320}
  overscan={4}
  key={(row) => row.id}
  onScroll={(scrollTop) => console.log(scrollTop)}
>
  {(row, index) => <div>{row.title}</div>}
</Virtual>
```

### Props

```ts
interface VirtualProps<T = unknown> {
  items: readonly T[];
  itemHeight: number;
  height: number;
  overscan?: number;
  tag?: string;
  key?: (item: T, index: number) => PropertyKey;
  onScroll?: (scrollTop: number) => void;
  /** children 必须是 `(item, index) => renderable`。 */
  children?: unknown;
}
```

### 语义

- 创建一个滚动容器；
- spacer 高度 = `items.length * itemHeight`；
- 只渲染可视区域 + overscan；
- 滚动时重新计算区间；
- 要求每行高度固定。

## 注册表

增强组件的元信息定义在 `@lania-v/shared`：

```ts
import {
  ENHANCED_COMPONENT_NAMES,
  ENHANCED_COMPONENT_REGISTRY,
  getEnhancedComponentRegistryEntry,
  getRequiredEnhancedParentComponentName,
  isEnhancedComponentName,
} from '@lania-v/shared';
```

| 字段                | 说明                                                        |
| ------------------- | ----------------------------------------------------------- |
| `name`              | 组件名                                                      |
| `category`          | `syntax` / `structure` / `structure-lifecycle` / `boundary` |
| `irKind`            | 编译后的 IR 类型                                            |
| `runtimeHostKind`   | `none` / `structural` / `boundary`                          |
| `supportsSsr`       | 是否支持 SSR                                                |
| `supportsHydration` | 是否支持 hydration                                          |
| `staticRenderMode`  | `preserve` / `flatten` / `children-only`                    |
| `metadataPropNames` | 参与编译元数据的 props                                      |

查询：

```ts
getEnhancedComponentRegistryEntry('Each');
// {
//   name: 'Each',
//   category: 'structure',
//   irKind: 'ListIR',
//   runtimeHostKind: 'structural',
//   supportsSsr: true,
//   supportsHydration: true,
//   staticRenderMode: 'preserve',
//   metadataPropNames: ['items', 'key', 'fallback'],
// }
```

父子约束：

```ts
getRequiredEnhancedParentComponentName('Then'); // 'When'
getRequiredEnhancedParentComponentName('Else'); // 'When'
getRequiredEnhancedParentComponentName('Case'); // 'Switch'
getRequiredEnhancedParentComponentName('Default'); // 'Switch'
```

## 协议 payload

编译期会为增强组件生成 payload，运行时通过协议字段校验：

```ts
const ENHANCED_CONTRACT_PROTOCOL = 'lania.enhanced';
const ENHANCED_CONTRACT_VERSION = '0.1-draft';
```

```ts
interface BoundaryPayload {
  protocol: 'lania.enhanced';
  version: '0.1-draft';
  payloadKind: 'boundary';
  component: 'Suspense' | 'ErrorBoundary' | 'LazyLoad';
  irKind: 'BoundaryIR';
  boundaryIndex: number;
  initialState: BoundaryState;
  childrenTemplate: EnhancedTemplateContract;
  metadata?: Record<string, unknown>;
}
```

业务代码通常不需要手写 payload；它由编译器生成，并作为 `payload` prop 传入。
