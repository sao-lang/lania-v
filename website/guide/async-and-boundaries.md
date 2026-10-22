# 异步与边界

`lania-v` 把异步渲染拆成两层：

- **数据层**：`createResource()` 管理请求状态；
- **渲染层**：`Suspense` / `ErrorBoundary` / `LazyLoad` / `Await` 决定等待、失败与延迟渲染时显示什么。

## `createResource()`

```ts
import { createResource, createSignal } from '@lania-v/runtime';

const userId = createSignal('1');

const [user, { loading, error, refetch }] = createResource(userId, async () => {
  const response = await fetch(`/api/users/${userId()}`);
  return response.json();
});
```

签名：

```ts
createResource<T>(
  key: Signal<any> | readonly Signal<any>[],
  fetcher: () => Promise<T>,
  options?: {
    initialValue?: T;
    scheduler?: Scheduler;
  }
): [
  ReadonlySignal<T | undefined>,
  {
    loading: ReadonlySignal<boolean>;
    error: ReadonlySignal<unknown>;
    refetch(): Promise<T | undefined>;
  }
];
```

行为：

- 创建时立即拉取一次；
- 任一 key Signal 变化时重新拉取；
- 使用递增 `requestId` 丢弃过期响应，避免慢请求覆盖新结果；
- `refetch()` 可手动重新拉取；
- `loading` / `error` 是只读 Signal。

```tsx
<When when={loading()} fallback={<UserCard user={user()} />}>
  <Spinner />
</When>

<When when={error()}>
  <p>加载失败：{String(error())}</p>
</When>
```

## `Suspense`

`Suspense` 捕获子树中 `throw` 出来的 Promise：

```tsx
<Suspense
  fallback={<Spinner />}
  onPending={(promise) => console.log('pending', promise)}
  onResolve={() => console.log('resolved')}
  onReject={(error) => console.error(error)}
>
  <LazyPanel />
</Suspense>
```

Props：

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

执行逻辑：

1. 先渲染 children；
2. 如果抛出 thenable，记录 pending 并渲染 `fallback`；
3. Promise resolve 后重放 children；
4. reject 时记录错误并调用 `onReject`；
5. 非 Promise 错误交给上层 `ErrorBoundary`（如果存在）。

`lazy()` 是最常见的 Promise 来源：

```ts
const LazyPanel = lazy(() => import('./LazyPanel.lania.tsx'));
```

## `ErrorBoundary`

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

Props：

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

行为：

- 捕获 children 渲染期间的同步错误；
- 记录错误后渲染 `fallback`；
- `reset()` 清空错误并重放 children；
- 只重置成功时才调用 `onReset`。

## `LazyLoad`

`LazyLoad` 在内容进入视口后才渲染 children：

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

Props：

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

行为：

- 使用 `IntersectionObserver` 观察 `target` 或首个实际渲染元素；
- 不可见时渲染 `fallback`，并插入一个 sentinel 作为观察锚点；
- `once` 为真时首次可见后停止观察；
- 环境不支持 `IntersectionObserver` 时直接渲染 children。

## `Await`

`Await` 是一个更轻量的 Promise 渲染器，不依赖边界协议：

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

Props：

```ts
interface AwaitProps<T> {
  value: Promise<T> | (() => Promise<T> | T) | T;
  fallback?: EnhancedRenderable | (() => EnhancedRenderable);
  error?: EnhancedRenderable | ((error: unknown) => EnhancedRenderable);
  delay?: number;
  onResolve?: (value: T) => void;
  onReject?: (error: unknown) => void;
  children?: unknown;
}
```

行为：

- `value` 是函数时会先调用；
- 不是 Promise 时同步渲染；
- 是 Promise 时先渲染 fallback（`delay` 大于 0 时延迟显示）；
- resolve 后用 `children(value)` 渲染；
- reject 时渲染 `error`，没有 `error` 则输出 `String(error)`。

`Await` 不会 `throw` Promise，因此不需要外层 `Suspense`。

## `lazy()`

```ts
import { lazy } from '@lania-v/runtime';

const LazyPanel = lazy(() => import('./LazyPanel.lania.tsx'));

await LazyPanel.preload(); // 手动预加载
LazyPanel.resolved(); // 已解析的组件或 null
```

语义：

- 未加载完成时调用会 `throw` 一个 Promise；
- 由最近的 `Suspense` 捕获；
- 同一个加载 Promise 会被复用；
- 支持直接导出组件或 `{ default: Component }`。

## 如何选择

| 场景                                | 推荐                  |
| ----------------------------------- | --------------------- |
| 请求数据并需要 loading / error 状态 | `createResource()`    |
| 懒加载组件代码                      | `lazy()` + `Suspense` |
| 局部异步内容，不想引入边界协议      | `Await`               |
| 长列表 / 图片 / 图表进入视口再渲染  | `LazyLoad`            |
| 捕获子树渲染错误                    | `ErrorBoundary`       |

## 完整示例

```tsx
import {
  createMemo,
  createResource,
  defineComponent,
} from '@lania-v/runtime';
import { ErrorBoundary, When } from '@lania-v/advanced';

const UserCard = defineComponent(function UserCard(props: { id: string }) {
  const id = createMemo(() => props.id);
  const [user, { loading, error, refetch }] = createResource(id, async () => {
    const response = await fetch(`/api/users/${id()}`);
    return response.json();
  });

  return (
    <ErrorBoundary
      fallback={(reason, reset) => (
        <div>
          <p>加载失败：{String(reason)}</p>
          <button onClick={reset}>重试</button>
        </div>
      )}
    >
      <When when={!loading() && !error()} fallback={<p>loading...</p>}>
        <article>
          <h3>{user()?.name}</h3>
          <button onClick={() => refetch()}>刷新</button>
        </article>
      </When>
      </Suspense>
    </ErrorBoundary>
  );
});
```

## 下一步

- [状态管理](/guide/state)：`createAtom`、`createDerivedAtom`、`createSelector`。
- [SSR 与部分水合](/guide/ssr)：异步边界的服务端输出与 hydration 标记。
- [增强组件 API](/api/enhanced-components)：完整 props 参考。
