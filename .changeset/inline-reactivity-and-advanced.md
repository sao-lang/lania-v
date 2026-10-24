---
'@lania-v/runtime': minor
'@lania-v/store': patch
'@lania-v/compiler-core': patch
'@lania-v/compiler-tsx': patch
'@lania-v/vite-plugin': patch
---

响应式核心与增强组件并入 runtime，作为二级入口暴露。

`@lania-v/reactivity` 与 `@lania-v/advanced` 已停止发布，能力迁移到：

- `@lania-v/runtime/reactivity`：`createSignal` / `createEffect` / `createMemo` /
  `createAtom` 依赖的响应式原语 / `batch` / `watch` / `readonly` / `untrack` 等；
- `@lania-v/runtime/advanced`：`When` / `Each` / `KeepAlive` / `Transition` /
  `Suspense` / `Virtual` 等增强组件。

runtime 一级入口不再导出响应式 API 与增强组件，仅保留 core / component / dom / render。

```diff
-import { createSignal, defineComponent } from '@lania-v/runtime';
+import { defineComponent } from '@lania-v/runtime';
+import { createSignal } from '@lania-v/runtime/reactivity';

-import { When } from '@lania-v/advanced';
+import { When } from '@lania-v/runtime/advanced';
```

`@lania-v/store` 改为依赖 `@lania-v/runtime`，不再依赖已删除的 `@lania-v/reactivity`。
