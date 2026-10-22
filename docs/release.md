# 独立发包与发布流程

本文档说明如何在当前 monorepo 中对 `@lania-v/*` 包执行独立版本管理、打包和发布到 npm。

## 当前策略

- 使用 `npm workspaces` 管理多包仓库。
- 使用 `changesets` 管理版本变更。
- `packages/*` 下的库包可独立升级、独立发布。
- `playground/*` 仅用于本地演示，不参与发布。

## 一次性准备

1. 登录 npm：

```bash
npm login
```

1. 首次发布前检查包名是否可用：

```bash
npm view @lania-v/runtime
npm view @lania-v/compiler-core
npm view @lania-v/compiler-tsx
npm view @lania-v/shared
npm view @lania-v/vite-plugin
```

1. 确保构建通过：

```bash
npm run build
```

如果构建失败，`changeset publish` 不应继续执行。

## 日常发版流程

### 1. 提交代码

按现有提交规范提交功能或修复代码。

### 2. 创建 changeset

执行：

```bash
npm run changeset
```

随后按提示选择：

- 哪些包需要升级
- 升级类型：`patch` / `minor` / `major`
- 变更说明

这会在 `.changeset/` 下生成一个 markdown 文件。

### 3. 生成版本变更

当准备正式发版时执行：

```bash
npm run version-packages
```

该命令会自动：

- 更新被选中包的版本号
- 更新相关内部依赖版本范围
- 生成或更新 changelog

建议在这一步之后提交一次版本变更：

```bash
git add .
git commit -m "chore(release): version packages"
```

### 4. 发布到 npm

执行：

```bash
npm run release
```

它会先构建，再执行：

```bash
changeset publish
```

### 5. 打 tag 并推送

如果你需要在仓库中保留发布记录，可手动打 tag：

```bash
git tag @lania-v/runtime@0.1.0
git push origin main --tags
```

独立发包场景下，通常按包名分别打 tag。

## 包配置约定

所有可发布包建议遵循以下规则：

- `private: false`
- `publishConfig.access = public`
- `main` 指向 `dist/*.js`
- `types` 指向 `dist/*.d.ts`
- `exports` 指向 `dist`
- `prepublishOnly` 中执行 `npm run build`

## 版本建议

独立发包时推荐：

- 对外 API 修复使用 `patch`
- 向后兼容新增功能使用 `minor`
- 不兼容改动使用 `major`
- 被依赖的内部包升级后，由 changesets 自动带动依赖方范围更新

## CI 发布建议

如果你要自动发布，建议在 CI 中配置：

1. 安装依赖
2. 执行 `npm run lint`
3. 执行 `npm run typecheck`
4. 执行 `npm run test`
5. 执行 `npm run build`
6. 执行 `changeset publish`

并通过环境变量注入：

- `NPM_TOKEN`

`.npmrc` 示例：

```text
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
```

## 当前注意事项

当前仓库存在若干 TypeScript 编译错误，主要在：

- `@lania-v/compiler-tsx`

这些错误会直接阻塞发布流程。应先修复构建，再执行正式发版。
