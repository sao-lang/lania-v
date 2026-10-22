# 编译报告

`@lania-v/compiler-core` 提供一个开箱即用的编译报告插件，把编译期已经算好的
slot / updater / 依赖信息整理成结构化摘要。

## 用法

```ts
import { createCompileReportPlugin } from '@lania-v/compiler-core';
import { laniaFcVitePlugin } from '@lania-v/vite-plugin';

const reportPlugin = createCompileReportPlugin((report) => {
  console.table(report.entries);
});

export default {
  plugins: [
    laniaFcVitePlugin({
      compilerPlugins: [reportPlugin],
    }),
  ],
};
```

## 字段

| 字段                   | 含义                          |
| ---------------------- | ----------------------------- |
| `component`            | 组件名                        |
| `slots`                | `renderPlan` 分配的 slot 总数 |
| `updaters`             | 生成的 updater 数量           |
| `signals`              | 组件内 signal 数量            |
| `computed`             | computed 数量                 |
| `effects`              | effect 数量                   |
| `dependencies`         | 依赖分析条目数                |
| `crossComponentUsages` | 跨组件 usage 数量             |

报告按组件增量回调：每生成一个组件产物就会调用一次 `onReport`，
适合直接接入构建脚本、CI 统计或调试面板。
