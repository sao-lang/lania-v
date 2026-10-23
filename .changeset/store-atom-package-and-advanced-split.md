---
'@lania-v/reactivity': major
'@lania-v/store': minor
'@lania-v/runtime': major
'@lania-v/advanced': major
'@lania-v/compiler-core': minor
'@lania-v/compiler-tsx': minor
---

新增原子化状态管理包 `@lania-v/store`，把响应式核心提取为 `@lania-v/reactivity`，
并把 runtime 的增强组件拆到 `@lania-v/advanced`。

### `@lania-v/reactivity`

- Signal / Memo / Effect / watch / Scheduler / Resource / Selector / Transition 整体独立成包；
- 不依赖框架运行时，可单独用于纯状态或副作用场景；
- `@lania-v/reactivity/internal` 暴露 `trackSignals` / `linkTrackedSignals` / `isTracking`；
- 自带 dev 判定与调试事件通道，runtime 通过 `setDevEnvironmentOverride()` 保持同步。

### `@lania-v/store`

- `createAtom()`：原子即 Signal，`atom.value` 读取、`atom.set()` 写入；对象 atom 支持路径级精确订阅；
- `set` 支持链式调用（`atom.set('a', 1).set('b', 2)`）与不可变的路径写入；
- `createDerivedAtom()`：派生原子，支持可写派生；
- `createAction()`：批量写入，内部走 `batch()`；
- `createAtomFamily()`：按 key 缓存原子；
- `createStore()` / `runWithStore()` / `bindStore()`：显式作用域与异步绑定；
- `snapshot()` / `hydrate()`：状态快照；
- 中间件：`persist` / `withHistory` / `withDevtools`。

### `@lania-v/runtime`（破坏性变更）

- 移除 `createStore()` / `produce()` 及其类型，迁移路径见状态管理文档；
- `createSignal()` 新增 `setValueWithPath()`，供外层状态封装做精确路径通知；
- 增强组件（`When` / `Each` / `KeepAlive` / `Transition` 等）移至 `@lania-v/advanced`；
  runtime 保留 `EnhancedRenderable` 等类型契约与 `registerEnhancedConstructor()` 注册表；
- 新增 `@lania-v/runtime/component/transition`、`@lania-v/runtime/component/lifecycle` 子路径，
  供 `@lania-v/advanced` 复用底层设施。

### `@lania-v/advanced`

- 新增包，承载全部增强组件；
- 依赖 `@lania-v/runtime`，加载时向 runtime 注册动态 slot 需要的构造器。

### 编译器

- `@lania-v/store` 的 `createAtom` / `createDerivedAtom` 被识别为信号声明，直接生成实例字段；
- `@lania-v/store` 的 import 不再被 runtime 前导合并，原样保留在产物中；
- 生成代码改用 `getAtomDependency()` 替代已移除的 `getStorePathSignal()`。
