# @lania-v/vite-plugin

Lania 的 Vite 集成层。

当前只保留 `.lania.tsx` 编译主线：

- `laniaFcVitePlugin()` 是明确入口
- `laniaVitePlugin()` 是兼容别名，行为与 `laniaFcVitePlugin()` 一致

## 安装

```bash
npm install @lania-v/vite-plugin
```

## 推荐用法

```ts
import { laniaFcVitePlugin } from '@lania-v/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [laniaFcVitePlugin()],
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: '@lania-v/runtime',
  },
});
```

默认只处理 `.lania.tsx` 文件。

## 兼容入口

```ts
import { laniaVitePlugin } from '@lania-v/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [laniaVitePlugin()],
});
```

`laniaVitePlugin()` 现在只是 `laniaFcVitePlugin()` 的别名。

## 可选项

### `laniaFcVitePlugin(options)`

```ts
type LaniaFcVitePluginOptions = {
  tsxInclude?: RegExp;
  tsxExclude?: RegExp;
  compilerPlugins?: CompilerPlugin[];
};
```

### `laniaVitePlugin(options)`

兼容入口与 `laniaFcVitePlugin(options)` 使用同一组选项。

## 行为说明

- 插件在 `transform` 阶段执行，`enforce` 为 `pre`
- `.lania.tsx` 会走 `compiler-tsx`
- 编译错误会被包装成 Vite overlay 友好的错误对象
- HMR 会按文件过滤后返回对应模块
