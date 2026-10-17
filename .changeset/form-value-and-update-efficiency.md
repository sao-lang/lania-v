---
'@lania-v/runtime': minor
'@lania-v/compiler-core': minor
'@lania-v/compiler-tsx': minor
---

新增 `useFormValue` 表单关联能力，并优化批量更新路径：

- `useFormValue(() => expr)` 会在编译期生成 `static formAssociated = true` 与同步 effect，组件因此参与原生表单提交（`form.elements` / `FormData`）。
- `registerComponentElement` 不再用后注册版本的 styles 覆盖已生效构造器，并在 dev 下对同名标签冲突给出告警。
- 修复同一 signal 触发两条更新路径（直接 updater + 组件级 requestUpdate）导致的重复求值。
- updater 在计算结果未变化时跳过 slot 写入；effect 型 updater 保持每次执行。
- 调度器热路径不再在非 dev 环境构造调试事件参数，`size` / `hasQueuedJobs` 改为计数器。
