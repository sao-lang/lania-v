---
'@lania-v/runtime': patch
'@lania-v/compiler-core': patch
'@lania-v/compiler-tsx': patch
'@lania-v/shared': patch
---

修复 Transition / TransitionGroup 及其它增强组件在编译产物中的失效问题：

- 编译产物补齐 `BoundarySlot` / `ComponentSlot` / `KeepAliveSlot` 的运行时解构，
  修复顶层 `<Transition>` / `<Suspense>` / `<ErrorBoundary>` / `<LazyLoad>` / `<KeepAlive>` / 静态自定义元素
  在编译组件里报 `xxx is not defined` 的问题。
- `generateClassComponentCode` 不再漏传 `componentBindings`，`ComponentSlot` 的 tagName 改为字符串字面量，
  对象字面量开头的 updater 表达式补括号，修复静态组件与对象 props 的生成代码语法错误。
- Transition 的离场快照改为复制结构性 slot 的节点缓冲区，避免 `IfSlot` 原地清空 buffer 后
  `leave` hook 拿不到任何元素、退场动画丢失。
- TransitionGroup 的 `keys` 现在会写入 block payload 并传给运行时；
  `ForSlot` 增加 `collectMountedNodes()`，keyed 列表不会再向过渡运行时暴露首次挂载时的旧节点；
  `resolveSnapshots` 不会复用已脱离文档的旧快照，避免跨挂载残留旧节点。
- LazyLoad 共享的 IntersectionObserver 改为始终回调最近一次挂载实例的配置，
  修复重新挂载后永远停留在 fallback 的问题。
- `BoundarySlot` 销毁后不再响应离场重放，避免卸载后把节点重新插回文档。
- Transition 每次 `reconcile` 后按 range 锚点回写节点缓冲区。
  此前缓冲区只记录首次挂载的内容，第二次 `leave` 会漏删旧节点、再次 `enter` 时叠加渲染，
  表现为反复切换后容器里堆积多个相同节点、高度被撑大。
- 离场 hook 的下一帧调度在页面不可见时改用定时器（后台标签页会暂停 `requestAnimationFrame`），
  并且等待动画结束时会按动画自身 `endTime` 兜底，避免动画被暂停时离场节点永久滞留在 DOM 中。
- 函数组件支持对象解构声明（`const { pending, start } = useTransition()`）：
  解构右值只求值一次，各绑定提升为实例字段，模板里的裸引用会改写成 `this.<name>`。
  同时支持别名、嵌套对象与 rest 元素，props 解构仍走原有的响应式替换逻辑。
