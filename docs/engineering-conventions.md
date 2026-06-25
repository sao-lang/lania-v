# 工程约定

## 1. 包之间的引用边界

- `@lania-v/shared` 只放跨包可复用的常量、类型和无 DOM 依赖工具。
- `@lania-v/runtime` 可以依赖 `@lania-v/shared`，不反向依赖编译器相关包。
- `@lania-v/compiler-core` 可以依赖 `@lania-v/shared`，负责 AST、IR、分析与 codegen 公共能力。
- `@lania-v/compiler-tsx` 只能构建在 `@lania-v/compiler-core` 之上。
- `@lania-v/vite-plugin` 只作为集成层，允许依赖编译器包，不允许反向下沉到 runtime。
- `playground/*` 只消费工作区包，不直接跨目录引用 `packages/*/src/*`。

## 2. 公共导出入口

- 运行时公共导出入口固定为 `packages/runtime/src/index.ts`。
- 编译器公共导出入口固定为各包的 `src/index.ts`。
- 新增公共 API 时，必须先从对应 `index.ts` 暴露，再允许 playground 或其他包消费。

## 3. 目录与产物约定

- 每个工作区包保留 `src/` 作为源码目录。
- `tsc` 输出统一进入包内 `dist/`。
- 对外发布时优先消费 `dist/`，开发期允许工作区通过 `src/index.ts` 获取源码能力。
- 需要新增演示能力时，先将 API 暴露到包入口，再从 playground 引入。

## 4. 命名规则

- 运行时对外类型优先使用明确名词：`Signal`、`Slot`、`Updater`。
- 泛型类型参数使用简短大写命名，如 `T`、`TValue`、`TNode`。
- 内部实现状态使用前导下划线，如 `_slots`、`_scheduler`、`_dirty`。
- DOM 相关槽位类型统一以 `Slot` 结尾，调度与派发类型统一以 `Updater` 或 `Scheduler` 结尾。

## 5. 分支命名

- 功能分支：`feat/<scope>-<summary>`
- 修复分支：`fix/<scope>-<summary>`
- 重构分支：`refactor/<scope>-<summary>`
- 文档分支：`docs/<scope>-<summary>`
- 试验分支：`chore/<scope>-<summary>`

示例：

- `feat/runtime-debug-hooks`
- `fix/compiler-tsx-loc`
- `docs/ssr-guide`

## 6. 提交规范

提交格式统一使用 Conventional Commits：

```text
<type>(<scope>): <subject>
```

示例：

```text
feat(runtime): add text slot updater
fix(playground): keep counter demo stable after reconnect
chore(repo): enable commitlint and husky
```

允许的 `type`：

- `feat`
- `fix`
- `docs`
- `style`
- `refactor`
- `perf`
- `test`
- `build`
- `ci`
- `chore`
- `revert`

推荐 `scope`：

- `runtime`
- `compiler-core`
- `compiler-tsx`
- `vite-plugin`
- `shared`
- `playground`
- `repo`
- `docs`
- `tests`

常用命令与 hooks：

- 交互式提交：`npm run commit`
- 提交信息校验：`commitlint`
- `pre-commit`：`lint + format:check + typecheck`
- `pre-push`：`test`
- `commit-msg`：`commitlint`

当前仓库若未初始化 Git，Husky 安装脚本会在 `prepare` 阶段自动跳过；执行 `git init` 后重新运行 `npm install` 即可激活 hooks。

## 7. Merge 与 Release 约定

- 默认使用 `squash merge` 保持主分支历史清晰。
- squash 后的提交信息继续遵循 Conventional Commits。
- 发布前保持 `main` 处于 `lint + typecheck + test` 全通过状态。
- 版本发布提交使用 `chore(release): <version>` 形式。
- 大型重构或阶段性收口允许保留单独里程碑提交，但提交信息仍需符合规范。

发布操作手册和 Changesets 流程见 `release.md`。
