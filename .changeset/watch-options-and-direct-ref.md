---
'@lania-v/runtime': minor
'@lania-v/compiler-tsx': minor
---

`watch()` 增加 `immediate` / `deep` 选项，`createRef()` 改为直接可读的模板引用：

- `watch(source, callback, options?, scheduler?)`：第三参改为选项，调度器后移到第四参。旧写法 `watch(source, callback, scheduler)` 不再被识别。
- `immediate: true` 会在创建时同步执行一次回调，首次 `previous` 为 `undefined`；`deep: true` 按值比较新旧快照，内容未变化时不触发回调。
- `createRef<T>()` 改为编译期 API：`.lania.tsx` 中会生成 `x: T | null = null` 实例字段，`ref={x}` 改写为对该字段赋值，业务侧直接写 `inputRef?.focus()`，不再需要 `.current`。
- 编译组件里 `ref={panelRef}` 现在会把 `createExpose()` 的返回值写入 `panelRef`；子组件没有暴露面时退回宿主元素。
- `watch()` 回调的 `previous` 类型在 `immediate: true` 时为 `T | undefined`，其余场景仍是 `T`。
