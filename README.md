# lania-v

`lania-v` 是一个编译优先的细粒度 Web Components 框架。

项目当前唯一主线为：

```text
TSX / FC -> Component IR -> renderPlan -> Updater -> Slot -> DOM
```

其中：

- `.lania.tsx` 是当前唯一输入入口
- `Component IR` 与 `renderPlan` 是统一编译核心
- `Signal -> Updater -> Slot -> DOM` 是统一运行时更新链路

完整架构说明见 [docs/technical-scheme.md](./docs/technical-scheme.md)。
模块与链路总览见 [docs/module-architecture.md](./docs/module-architecture.md)。
文档导航见 [docs/README.md](./docs/README.md)。

## 工作区结构

- `packages/runtime`: 运行时核心
- `packages/compiler-core`: 编译器公共能力
- `packages/compiler-tsx`: TSX 编译入口
- `packages/vite-plugin`: Vite 集成层
- `packages/shared`: 跨包共享代码
- `playground/*`: 本地演示与验收入口

## 常用命令

```bash
npm install
npm run dev
npm run test
npm run test:coverage
npm run lint
npm run typecheck
npm run build
npm run commit
```

## 工程约定

- 架构与收敛规则见 [docs/technical-scheme.md](./docs/technical-scheme.md)
- 运行时 API 与 `FC / TSX` 主路径见 [docs/runtime-api.md](./docs/runtime-api.md)
- 工程边界、提交规范与 hooks 说明见 [docs/engineering-conventions.md](./docs/engineering-conventions.md)
- 当前执行主计划见 [docs/plan.md](./docs/plan.md)
- 阶段收敛与版本目标见 [docs/stages.md](./docs/stages.md)
