# lania-v

`lania-v` 是一个编译优先的细粒度 Web Components 框架，以 `.lania.tsx` 为输入，通过统一编译管线将组件声明转为运行时可执行计划，并基于 Signal 响应式系统驱动细粒度 DOM 更新。项目明确拒绝 Virtual DOM 和整树 Diff 作为主更新模型。

## 核心理念

```text
TSX / FC → Component IR → renderPlan → Updater → Slot → DOM
```

框架将工作拆分为 **编译期** 和 **运行期** 两个阶段：

- **编译期**：将 `.lania.tsx` 源码解析为统一 `Component IR`，经过依赖分析、slot/updater 规划，生成 `renderPlan` 和最终代码。
- **运行期**：`Signal.set → Scheduler → Updater.run → Slot.write → DOM`，一条精确更新链路，只更新变化的部分，不做整树对比。

### 分层架构

```text
Authoring         FC / TSX (.lania.tsx)

Compiler          Parse → AST → Component IR → Dependency Analysis
                  → renderPlan → Codegen

Runtime           ReactiveElement → Signal / Computed / Effect
                  → Scheduler → Updater → Slot → DOM

Integration       Vite Plugin / Playground / Debug / HMR
```

## 模块布局

项目采用 monorepo 结构，`packages/*` 为可复用核心包，`playground/*` 为本地演示与验收入口：

```
lania-v/
├── packages/
│   ├── runtime/           运行时核心
│   │   ├── reactivity/    Signal、Computed、Effect、Store、Resource
│   │   ├── dom/           Slot、Updater、指令、样式绑定
│   │   ├── render/        DOM 渲染、SSR 渲染
│   │   ├── component/     组件宿主、增强组件、生命周期、Transition
│   │   └── core/          Context、Debug、环境
│   ├── compiler-core/     编译器核心（协议无关）
│   │   ├── ast/           统一 AST 结构
│   │   ├── ir/            Component IR、模板 Lowering、Render Bindings
│   │   ├── analysis/      依赖分析、跨组件分析
│   │   ├── plan/          Slot 分配、Updater 生成
│   │   ├── codegen/       Render Code、SSR Code 生成
│   │   ├── transform/     模板优化、表达式优化
│   │   ├── diagnostics/   错误定位与诊断
│   │   └── pipeline/      编译管线编排
│   ├── compiler-tsx/      .lania.tsx 编译入口
│   │   ├── syntax/        TSX 预处理与绑定语法归一化
│   │   ├── parse/         函数组件、模板、表达式解析
│   │   ├── analysis/      TSX 侧语义分析
│   │   └── compile/       编译入口与模块输出
│   ├── vite-plugin/       Vite 集成层（文件过滤、编译调用、HMR）
│   └── shared/            跨包共享契约（增强组件注册表、协议常量）
├── playground/
│   ├── todo/              默认开发入口与功能验收
│   ├── login/             表单与交互验收（登录页）
│   ├── compiler/          编译链路可视化
│   └── benchmark/         横向性能基准
├── docs/                  文档
└── tests/                 测试
```

## 快速开始

### 前置条件

- Node.js 18+
- npm

### 启动开发环境

```bash
npm install
npm run dev
```

### 运行测试

```bash
npm run test            # 单元测试
npm run test:e2e        # E2E 测试
npm run test:coverage   # 覆盖率
npm run bench           # 性能基准
```

### 质量检查

```bash
npm run typecheck       # 类型检查
npm run lint            # ESLint + MarkdownLint
npm run build           # 构建所有包
```

## 推荐接入路径

1. 通过 `npm run dev` 启动 playground，在 `playground/todo` 中编写 `.lania.tsx` 组件
2. Vite 插件自动拦截 `.lania.tsx` 文件，调用 `compiler-tsx` → `compiler-core` 完成编译
3. 编译产物由 `runtime` 接管，ReactiveElement 挂载后按 `renderPlan` 执行渲染
4. 数据变更时，Signal 触发 Scheduler → Updater → Slot 的精确更新链路

## 文档索引

- [文档导航](docs/README.md)
- [技术方案](docs/technical-scheme.md) — 唯一架构入口，定义主线、边界和收敛规则
- [模块与链路总览](docs/module-architecture.md) — 模块职责、联动关系与完整链路
- [快速上手](docs/getting-started.md)
- [运行时 API](docs/runtime-api.md)
- [SSR / Hydration](docs/ssr-hydration.md)
- [增强组件](docs/enhanced-components.md)
- [FC 绑定 API](docs/fc-binding-apis.md)
- [工程约定](docs/engineering-conventions.md)
- [执行计划](docs/plan.md)
- [阶段收敛](docs/stages.md)
- [发布流程](docs/release.md)
- [性能基准](docs/benchmark.md)
- [Showcase e2e 收尾方案](docs/showcase-e2e-followup.md)

## License

[MIT](LICENSE)