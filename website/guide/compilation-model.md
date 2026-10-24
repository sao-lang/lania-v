# 编译模型

`lania-v` 的核心假设是：**组件模板的结构和依赖在编译期已经确定**。因此运行时不需要 VNode，也不需要 Diff。

这一章沿着一次编译的顺序，解释 TSX 如何变成可执行计划。

## 总览

```text
.lania.tsx
  → TSX 预处理（拆分扩展绑定名）
  → TypeScript AST
  → CompilerProgram
  → Component IR
  → 依赖分析
  → Slot 分配
  → Updater 规划
  → renderPlan
  → 生成组件类代码
  → Vite 转译与 HMR 包装
```

## 1. TSX 预处理

TypeScript 的 JSX 解析器只接受标准属性名。`lania-v` 支持 `onClick.stop` 这类后缀修饰符，因此编译器会先把属性名中的 `.` 转义成占位符，解析后再还原。

标准 JSX 属性写法：

```tsx
<input model={{ target: draft, modifiers: { trim: true } }} />
```

`model:value`、`class:active`、`on:close` 等旧式指令写法会在入口直接报迁移错误。

## 2. Component IR

解析结果会先被 lowering 成统一的 `ComponentIR`：

```ts
interface ComponentIR {
  type: 'ComponentIR';
  name: string;
  props: PropIR[];
  signals: SignalIR[];
  computed: ComputedIR[];
  effects: EffectIR[];
  lifecycle: LifecycleIR;
  template: TemplateIR;
  renderPlan: ComponentRenderPlanIR;
  dependencyAnalysis: DependencyAnalysisIR;
  slotAllocation: SlotAllocationIR;
  updaterGeneration: UpdaterGenerationIR;
}
```

模板部分会被转成一组结构节点：

| 节点           | 含义                                     |
| -------------- | ---------------------------------------- |
| `ElementIR`    | 普通元素、静态属性、动态属性、事件、指令 |
| `TextIR`       | 静态文本                                 |
| `ExpressionIR` | 动态文本插值                             |
| `IfIR`         | 条件分支                                 |
| `ListIR`       | 列表                                     |
| `DynamicIR`    | 动态组件 / 插槽 / `Await` / `Virtual`    |
| `TeleportIR`   | Teleport                                 |
| `KeepAliveIR`  | KeepAlive                                |
| `TransitionIR` | Transition / TransitionGroup             |
| `BoundaryIR`   | Suspense / ErrorBoundary / LazyLoad      |

## 3. 依赖分析

编译器会分析：

- 模板表达式读取了哪些 Signal；
- 读取了 Store 的哪些稳定路径；
- 跨组件传递的依赖优先级；
- 哪些表达式不依赖任何响应式值，可以静态化。

依赖分析的产物会进入 `renderPlan.signalBindingMap` 与 `renderPlan.storeBindingMap`。

对于状态路径，编译器只保留**可静态命名**的部分。遇到动态下标会截断到最后一个静态前缀：

```ts
const state = createAtom({ list: [{ name: 'a' }] }, { key: 'state' });

state.value.list[0].name; // 可稳定分析的路径
state.value.list[index].name; // 动态下标，截断到 list
```

## 4. Slot 分配

::: tip 术语
这里的 Slot 是**运行时更新槽**，不是组件插槽。组件插槽见 [插槽](/guide/slots)。
:::

Slot 是运行时最小的写入单位。编译器会为每个动态位置分配一个 Slot：

```ts
interface SlotAllocationIR {
  slots: Array<{
    slotIndex: number;
    type: string;
    binding: unknown;
  }>;
}
```

常见的 Slot 类型：

| 类型                     | 写入目标             |
| ------------------------ | -------------------- |
| `text`                   | 文本节点             |
| `attribute` / `property` | 元素属性             |
| `class` / `style`        | class / style 字符串 |
| `event`                  | 事件监听             |
| `ref`                    | ref 写入             |
| `if`                     | 条件块               |
| `for`                    | 列表块               |
| `component`              | 组件属性             |
| `dynamic`                | 动态组件             |
| `boundary`               | 异步边界             |
| `teleport`               | Teleport             |
| `keepalive`              | 缓存块               |
| `directive`              | 自定义指令           |

## 5. Updater 规划

Updater 负责“算值 + 写 Slot”。编译器会按依赖关系合并 Updater：

- `SimpleUpdater`：一个表达式写一个 Slot；
- `MultiSlotUpdater`：一个表达式写多个 Slot；
- `ConditionUpdater`：条件分支；
- 结构型 Updater：列表、动态组件、边界等。

生成结果大致如下：

```ts
const countText = new SimpleUpdater(
  () => `count: ${this.count()}`,
  this.__slot_1,
  'normal',
  this._scheduler,
  this._slotTable
);

countText.deps.add(this.count);
this.registerRuntimeUpdater(countText);
```

## 6. renderPlan

`renderPlan` 是 codegen 的直接输入，也是调试时最值得观察的对象：

```ts
interface ComponentRenderPlanIR {
  staticHtml: string;
  textBindings: RenderTextBindingPlan[];
  componentBindings: RenderComponentBindingPlan[];
  listBindings: RenderListBindingPlan[];
  conditionBindings: RenderConditionBindingPlan[];
  dynamicBindings: RenderDynamicBindingPlan[];
  boundaryBindings: RenderBoundaryBindingPlan[];
  transitionBindings: RenderTransitionBindingPlan[];
  keepAliveBindings: RenderKeepAliveBindingPlan[];
  teleportBindings: RenderTeleportBindingPlan[];
  runtimeUpdaters: RenderRuntimeUpdaterPlan[];
  signalBindingMap: Record<string, string>;
  storeBindingMap: Record<string, string>;
}
```

它已经不再是树，而是一份**线性渲染计划**。运行时只需要：

1. 克隆 `staticHtml`；
2. 按 `slotIndex` 找到锚点；
3. 注册 Updater；
4. 写入首屏值。

## 7. 生成组件类

```tsx
const Counter = defineComponent(function Counter() {
  const count = createSignal(0);
  return (
    <button onClick={() => count.set((v) => v + 1)}>count: {count()}</button>
  );
});
```

会生成一个大致如下的类：

```ts
class Counter extends ReactiveElement {
  static tagName = 'x-counter';
  static renderMode = 'shadow';

  count = createSignal(0);

  _renderAndMount() {
    const template = __Counter_staticTemplate;

    const slot_0 = new EventSlot(/* button */, 'click', 0);
    const slot_1 = new TextSlot(/* text */, 1);

    this.registerSlot(slot_0);
    this.registerSlot(slot_1);

    slot_0.write(() => this.count.set((value) => value + 1));

    const updater = new SimpleUpdater(
      () => `count: ${this.count()}`,
      slot_1,
      'normal',
      this._scheduler,
      this._slotTable
    );
    updater.deps.add(this.count);
    this.registerRuntimeUpdater(updater);

    updater.run();
  }
}
```

实际产物还会包含：

- 静态模板 hoist；
- 组件属性快照；
- prop options 解析；
- SSR 的 `static render()`；
- dev 模式的 `__laniaSetup`（用于 HMR 重挂载）；
- 事件委托与 block payload 逻辑。

## 为什么这能省掉 Diff

假设模板是：

```tsx
<p>{title()}</p>
<span>{count()}</span>
```

编译器知道：

- `title` 只影响第一个文本节点；
- `count` 只影响第二个文本节点。

运行时不会重新执行整个模板，也不会比较 `<p>` 和 `<span>` 的结构。`title.set()` 只会让第一个 Updater 进入调度队列。

## 调试编译产物

在 Vite 开发模式下启用 `debug: true`：

```ts
laniaFcVitePlugin({ debug: true });
```

控制台会输出可展开的快照，并暴露 `__lania.compile()`：

```js
__lania.compile().Counter.ir.signals;
__lania.compile().Counter.renderPlan;
__lania.compile().Counter.moduleCode;
```

在 Login playground 中还可以观察运行时更新链路：

```js
__lania.snapshot();
__lania.trace.slice(-10);
```

详见 [开发与调试](/guide/dev-and-debug)。

## 下一步

- [更新链路](/advanced/update-pipeline)：从 `set()` 到 DOM 的完整执行顺序。
- [编译管线](/advanced/compiler-pipeline)：插件钩子与各阶段职责。
