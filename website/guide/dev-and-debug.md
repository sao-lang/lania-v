# 开发与调试

`lania-v` 的开发体验围绕三件事：编译快照、更新链路、热更新。

## Vite 插件选项

```ts
import { defineConfig } from 'vite';
import { laniaFcVitePlugin } from '@lania-v/vite-plugin';

export default defineConfig({
  plugins: [
    laniaFcVitePlugin({
      debug: true,
      hotReload: true,
      tsxInclude: /\.lania\.tsx$/,
      tsxTemplateSyntaxMode: 'jsx-standard',
    }),
  ],
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: '@lania-v/runtime',
  },
});
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `debug` | `false` | 开发态输出编译快照，并暴露 `globalThis.__laniaCompile` |
| `hotReload` | `true` | 开发态生成可重跑的 `__laniaSetup()` |
| `tsxInclude` | `/\.lania\.tsx$/` | 需要编译的文件 |
| `tsxExclude` | `undefined` | 排除规则 |
| `tsxTemplateSyntaxMode` | `jsx-standard` | `jsx-standard` 或 `directive-extended` |
| `compilerPlugins` | `undefined` | 传给 compiler-core 的插件 |

## 编译快照

开启 `debug: true` 后，浏览器控制台会输出：

```text
[lania-v] compile: LoginPage
  TSX / FC
  Component IR
  renderPlan
  Generated module
```

这些对象是真实的编译期快照，可以逐层展开。

### `__laniaCompile`

```js
__laniaCompile.LoginPage.ir.signals;
__laniaCompile.LoginPage.ir.slotAllocation;
__laniaCompile.LoginPage.ir.updaterGeneration;
__laniaCompile.LoginPage.renderPlan;
__laniaCompile.LoginPage.moduleCode;
```

`__laniaCompile` 只在 `vite dev` 且 `debug: true` 时注入，不进入生产构建。

## 运行时调试钩子

```ts
import { registerRuntimeDebugHooks } from '@lania-v/runtime';

const dispose = registerRuntimeDebugHooks({
  onSignalEvent(event) {
    console.log('signal.set', event.signalId, event.previous, event.current);
  },
  onSchedulerEvent(event) {
    console.log('scheduler', event.type, event.priority, event.queueSize);
  },
  onLifecycleEvent(event) {
    console.log('lifecycle', event.type, event.tagName);
  },
  onDevtoolsEvent(event) {
    if (event.type === 'updater-run' || event.type === 'slot-write') {
      console.log(event.type, event.payload);
    }
  },
});

dispose();
```

其他调试导出：

```ts
import {
  clearRuntimeDebugHooks,
  hasDevtoolsSubscribers,
  setDevEnvironmentOverride,
} from '@lania-v/runtime';

hasDevtoolsSubscribers(); // 是否有订阅者
clearRuntimeDebugHooks(); // 清空所有 hooks
```

事件类型：

```ts
type SchedulerEventType =
  | 'schedule'
  | 'schedule-lifecycle'
  | 'schedule-effect'
  | 'flush-start'
  | 'flush-end'
  | 'schedule-unit'
  | 'unit-run';

type LifecycleEventType =
  | 'connected'
  | 'disconnected'
  | 'request-update'
  | 'will-update'
  | 'updated'
  | 'first-updated';
```

这些钩子只在开发环境（`isDevEnvironment()` 为真）下产生事件。

### 自定义检查器

Login playground 展示了如何把事件汇总成可查询的快照：

```ts
const signals = new Map();
const updaters = new Map();
const trace: unknown[] = [];

registerRuntimeDebugHooks({
  onSignalEvent(event) {
    const previous = signals.get(event.signalId);
    signals.set(event.signalId, {
      signalId: event.signalId,
      sets: (previous?.sets ?? 0) + 1,
    });
  },
  onDevtoolsEvent(event) {
    if (event.type === 'updater-run') {
      const payload = event.payload as { updaterId: number };
      const previous = updaters.get(payload.updaterId);
      updaters.set(payload.updaterId, {
        updaterId: payload.updaterId,
        runs: (previous?.runs ?? 0) + 1,
      });
    }
    trace.push(event);
  },
});

Object.assign(globalThis, {
  __lania: {
    trace,
    compile: () => (globalThis as any).__laniaCompile ?? {},
    snapshot: () => ({
      signals: [...signals.values()],
      updaters: [...updaters.values()],
      traceLength: trace.length,
    }),
    clear: () => {
      trace.length = 0;
      signals.clear();
      updaters.clear();
    },
  },
});
```

然后在控制台：

```js
__lania.compile().LoginPage.ir.slotAllocation;
__lania.snapshot();
console.table(__lania.snapshot().updaters);
__lania.trace.slice(-10);
```

`Updater.run.dependencyIds` 对应 Signal 的 `debugId`；`slots[].index` 对应 IR 的 `slotIndex`，可以把一次更新追溯到具体绑定。

## 更新高亮

```ts
import { installDevtoolsOverlay } from '@lania-v/runtime/advanced';

const dispose = installDevtoolsOverlay({
  durationMs: 300,
  color: '#22d3ee',
});
```

开发态订阅 `slot-write` 事件，给真正被写入的 DOM 节点加 outline。

## 运行时插件

```ts
import { useRuntimePlugin } from '@lania-v/runtime';

const dispose = useRuntimePlugin({
  name: 'logger',
  setup(api) {
    api.registerDebugHooks({
      onLifecycleEvent(event) {
        console.log(event.type, event.tagName);
      },
    });

    return () => {
      console.log('plugin disposed');
    };
  },
});
```

`RuntimePluginAPI`：

```ts
interface RuntimePluginAPI {
  isDev: boolean;
  warning: (message: string, condition?: boolean) => boolean;
  assert: (condition: unknown, message: string) => asserts condition;
  registerDebugHooks: (hooks: RuntimeDebugHooks) => () => void;
  emitDevtoolsEvent: (type: string, payload?: unknown) => void;
}
```

## 警告与断言

```ts
import { warning, assert } from '@lania-v/runtime';

warning('props.title is deprecated');
assert(value != null, 'value is required');
```

`warning()` 在开发环境输出 `[lania-v] ...`，并发送 devtools 事件；生产环境不输出。

## HMR

Vite 插件在开发态自动注入：

```ts
if (import.meta.hot) {
  installComponentHmr();
  import.meta.hot.accept();
}
```

HMR 语义：

- 同名自定义元素不会重复 `define`；
- 新构造器会热替换已有实例的原型；
- 开发态把 setup 收集到 `__laniaSetup()`，新增的 setup 状态可以重建；
- 已有 Signal / Store / props 字段会按字段名保留；
- 模板与事件绑定会重新挂载。

手动控制：

```ts
import {
  installComponentHmr,
  uninstallComponentHmr,
  isComponentHmrEnabled,
  captureComponentState,
  restoreComponentState,
  applyComponentHmrUpdate,
} from '@lania-v/runtime';

installComponentHmr();
// ...
uninstallComponentHmr();
```

`isComponentHmrEnabled()` 返回当前是否已安装 HMR 桥；`applyComponentHmrUpdate(tagName, ctor)` 用于把新构造器热替换到已注册标签上，Vite 插件会自动调用。

### HMR 边界

- 修改模板、事件、样式：保留实例状态；
- 修改 setup 新增字段：需要 `hotReload: true`（默认）；
- 修改组件名 / 标签名：会被视为新组件；
- 修改模块级常量：如果被编译产物引用，会随模块热替换。

## 测试

运行时提供统一的共享状态重置入口：

```ts
import { resetRuntimeTestState } from '@lania-v/runtime/testing';
import { afterEach } from 'vitest';

afterEach(() => {
  resetRuntimeTestState();
});
```

它会清空：

- 自定义指令注册表；
- KeepAlive 缓存；
- Suspense / ErrorBoundary / LazyLoad 状态；
- Transition / TransitionGroup 注册表。

## 环境判断

```ts
import { isDevEnvironment, setDevEnvironmentOverride } from '@lania-v/runtime';

isDevEnvironment();            // 开发构建为 true
setDevEnvironmentOverride(true);  // 测试时强制开启
setDevEnvironmentOverride(null);  // 恢复默认
```

## 下一步

- [最佳实践](/guide/best-practices)：组织组件与调试生产问题。
- [更新链路](/advanced/update-pipeline)：调度器内部顺序。
- [Vite 插件 API](/api/plugin)：插件完整选项。
