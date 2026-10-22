# 开发态组件热更新（HMR）

本文档描述 `lania-v` 在 `vite dev` 下的组件热更新行为与状态保留语义。

## 为什么需要专门一层

自定义元素一旦 `customElements.define()` 注册就不能重新定义。默认情况下
`.lania.tsx` 模块热更新后，新构造器会被注册表丢弃，页面只能整页刷新或残留旧实现。
运行时因此在 dev 下提供“原型热替换 + 同实例重新挂载”的桥接层。

## 自动接入

`laniaFcVitePlugin` 在 `vite dev` 时给每个 `.lania.tsx` 模块追加：

```js
import { installComponentHmr as __laniaInstallComponentHmr } from '@lania-v/runtime';

if (import.meta.hot) {
  __laniaInstallComponentHmr();
  import.meta.hot.accept();
}
```

效果：

- 模块自我接受，热更新不再触发整页 reload；
- 重新执行 `defineComponent()` 时，同名标签的注册冲突会走 HMR 桥接而不是告警丢弃。

生产构建不会注入这段代码。

## 运行时流程

1. 新模块执行，产生新构造器；
2. `registerComponentElement()` 发现标签已被旧构造器占用；
3. `applyComponentHmrUpdate(tagName, nextCtor)`：
   - 把新构造器的原型方法与静态配置（`styles` / `propOptions` / `emits` /
     `handlerKeys` / `renderMode` / `hydration` 等）覆盖到旧构造器；
   - 对页面上每个实例采集状态，调用 `__laniaHmrRemount()`，再按字段名回填；
4. `__laniaHmrRemount()` 清理挂载期产物（slots / updaters / 渲染节点），
   重新执行 setup（dev 产物里的 `__laniaSetup()`），再用新模板挂载一次。

### dev 产物：可重跑的 setup

`vite dev` 下编译产物会把字段初始化收进方法：

```ts
class Card extends ReactiveElement {
  private __prop_title: any;
  protected count: any;
  protected __laniaSetup(): void {
    this.__prop_title = createSignal(
      resolvePropInitialValue(this, 'title', undefined)
    );
    this.count = createSignal(0);
  }
  constructor() {
    super();
    this.__laniaSetup();
  }
}
```

因此 HMR 时新增/删除 setup 状态也能生效：新字段按初始值创建，同名旧字段的值会被回填。
生产构建保持字段初始化器形态（`hotReload: false`），没有额外运行时成本。

### 新增 attribute 也能生效

`observedAttributes` 在 `customElements.define()` 时被浏览器固化，HMR 新增 attribute
无法再触发原生回调。dev 下 `ReactiveElement` 会挂一个 `MutationObserver` 兜底：
只转发“当前 `observedAttributes` 未覆盖”的属性变化，避免与原生回调重复。

保存即可看到效果，不需要手动配置。

## 保留什么、不保留什么

保留：

- 组件实例本身（DOM 节点不变，focus 与滚动位置基本不受影响）；
- 实例上的 signal / store / props 值（按字段名回填）；
- 事件绑定（重新挂载时按新代码重新生成）；
- 新增的 setup 状态（dev 产物重新执行 `__laniaSetup()`）。

不保留：

- 被删除或重命名的 setup 字段，其旧值会被丢弃（字段名是状态迁移的 key）；
- 组件内部子组件实例会被重新挂载。

## 手动 API

```ts
import {
  applyComponentHmrUpdate,
  captureComponentState,
  restoreComponentState,
  installComponentHmr,
  uninstallComponentHmr,
  isComponentHmrEnabled,
} from '@lania-v/runtime';
```

- `installComponentHmr()` / `uninstallComponentHmr()`：开关桥接层；
- `applyComponentHmrUpdate(tagName, nextCtor)`：手动热替换，返回被重挂载的实例数；
- `captureComponentState(element)` / `restoreComponentState(element, state)`：
  面向“必须重建节点”的场景（例如宿主没有 `__laniaHmrRemount()`）的状态迁移工具。

## 当前边界

- 只在 `import.meta.hot` 存在的 dev 环境生效。
- 只覆盖自定义元素（编译产物）路径；运行时手写 JSX 仍需上层框架自行处理。
- 状态迁移按字段名对齐，字段重命名等价于“新状态”。
- `hotReload: false` 可以关掉 dev 的 `__laniaSetup` 产物（例如排查发布形态问题时）。
