# docs 导航

本文档是 `docs/` 目录的统一入口。

当前目录只保留主线文档、必要专题文档和执行文档；原先分散的导航类文档与版本阶段说明已合并到这里和 `stages.md`。

## 推荐顺序

1. `getting-started.md`：先把 playground 跑起来。
2. `technical-scheme.md`：理解项目的唯一主线和分层边界。
3. `module-architecture.md`：查看模块职责、模块联动和完整链路。
4. `runtime-api.md`：查看运行时 API 与 `FC / TSX` 主路径。
5. `ssr-hydration.md`：查看 SSR / Hydration 能力边界。
6. `stages.md`：查看当前阶段结论、版本目标和历史说明。

## 按目标阅读

- 初次上手：`getting-started.md` -> `technical-scheme.md` -> `runtime-api.md`
- 想快速建立模块心智：`module-architecture.md`
- 想改 runtime：`runtime-api.md` -> `enhanced-components.md` -> `packages/runtime/src/*`
- 想改 compiler：`technical-scheme.md`
  -> `packages/compiler-core/src/{ir,analysis,plan,codegen}`
  -> `packages/compiler-tsx/src`
- 想改增强组件：`enhanced-components.md` -> `runtime-api.md` -> `fc-binding-apis.md`
- 想改 SSR / Hydration：`ssr-hydration.md` -> `tests/runtime-render.test.ts` -> `tests/e2e/*`
- 想看工程流程：`engineering-conventions.md` -> `release.md` -> `benchmark.md`

## 文档分层

- 架构主文档：`technical-scheme.md`
- 模块总览：`module-architecture.md`
- 运行时主文档：`runtime-api.md`
- SSR 主文档：`ssr-hydration.md`
- 专题补充：`enhanced-components.md`、`fc-binding-apis.md`
- 执行与阶段：`plan.md`、`stages.md`
- 工程流程：`engineering-conventions.md`、`release.md`、`benchmark.md`

## 源码阅读路线

### Runtime

建议顺序：

1. `packages/runtime/src/reactivity`
2. `packages/runtime/src/dom`
3. `packages/runtime/src/render`
4. `packages/runtime/src/component`

重点只抓一条链：

```text
signal.set -> scheduler.enqueue -> updater.run -> slot.write -> DOM update
```

### Compiler

建议顺序：

1. `packages/compiler-core/src/ir`
2. `packages/compiler-core/src/analysis`
3. `packages/compiler-core/src/plan`
4. `packages/compiler-core/src/codegen`
5. `packages/compiler-tsx/src`

重点建立三个认知：

- `TSX` 如何进入 `Component IR`
- `renderPlan` 如何承接编译结果
- codegen 如何把 IR 变成 runtime 可执行产物

## 测试入口

建议先只看测试标题建立支持面，再回到输入和断言确认真实语义：

- `tests/runtime-slot.test.ts`
- `tests/runtime-render.test.ts`
- `tests/runtime-function-component.test.ts`
- `tests/compiler-render-codegen.test.ts`
- `tests/compiler-plugin.test.ts`
- `tests/e2e/*`

## 历史说明

- 旧的导航文档已合并到本文件，不再单独保留。
- 原先分散的 `v0.1` / `v0.2` / 历史说明已收口到 `stages.md`。
- 更早的宽口径设计背景以 Git 历史为准，不再在 `docs/` 中保留独立占位文档。
