# 编译管线

这一章按执行顺序拆解编译器内部阶段。

## 入口

```text
Vite transform
  → compileFunctionComponentTsxModule(fileName, source, options, mode)
      → parseFunctionComponentTsx
      → runComponentCompilerPipeline
      → generateClassComponentCode
      → emitFunctionComponentTsxModule
```

## 1. TSX 预处理

`syntax/tsx-binding.ts` 负责把扩展绑定名改成 TypeScript 能解析的形态：

```text
model:value.trim  → model__LANIA_DOT__value__LANIA_DOT__trim
style:width.px    → style__LANIA_DOT__width__LANIA_DOT__px
```

解析后再还原。这样做的原因：

- TypeScript 的 JSX 属性名不允许 `.`；
- 预处理可以把扩展语法集中在入口处理，后续阶段只面对统一名字。

`jsx-standard` 模式不做这层扩展，只接受标准属性。

## 2. 函数组件解析

`parse/function` 从 `defineComponent(...)` 中提取：

| 产物          | 说明                                  |
| ------------- | ------------------------------------- |
| props         | 参数名、类型声明、解构信息            |
| signals       | `createSignal` 声明                   |
| computed      | `createMemo` 声明                     |
| effects       | `createEffect` 声明                   |
| lifecycle     | `onMount` / `onCleanup` / `onUpdated` |
| setupBindings | 其余语句与方法                        |
| 模板          | `return` 的 JSX                       |

同时会把 props 解构重写为实例字段访问：

```ts
const { title, count: total } = props;
// →
// title 读取 this.title
// total 读取 this.count
```

## 3. 模板解析

`parse/template` 把 JSX 转成 `TemplateNode`：

```ts
type TemplateNode = ElementNode | TextNode | ExpressionNode | DirectiveNode;
```

并完成：

1. 空白归一化；
2. Fragment 展开；
3. 属性分类（普通属性 / 事件 / 指令）；
4. 增强组件父子约束校验；
5. `html` 与 children 互斥校验；
6. 对象字面量形状校验。

## 4. CompilerProgram

```ts
interface CompilerProgram {
  sourceKind: 'tsx' | 'template';
  components: ComponentDeclaration[];
  ...
}
```

一个 `.lania.tsx` 可以声明多个组件，每个组件都会进入后续管线。

## 5. Component IR

`lowerProgramToComponentIR` 把每个组件转成 `ComponentIR`：

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
  ...
}
```

模板 lowering 会把 JSX 树转成结构节点：

```text
ElementNode → ElementIR
ExpressionNode → ExpressionIR
<When> → IfIR
<Each> → ListIR
<Teleport> → TeleportIR
<KeepAlive> → KeepAliveIR
<Transition> → TransitionIR
<Suspense> → BoundaryIR
```

## 6. 模板优化

`optimizeComponentTemplate`：

- 静态子树提升；
- 常量表达式折叠；
- 静态属性内联；
- 移除不参与运行时的语法节点。

`optimizeComponentUpdaters`：

- 合并读写同一依赖的 Updater；
- 去掉重复 Slot；
- 按优先级重排。

## 7. 依赖分析

`analyzeComponentDependencies` 输出：

```ts
interface DependencyAnalysisIR {
  templateDependencies: ...;
  computedDependencies: ...;
  effectDependencies: ...;
  effectDependencyChain: Record<string, string[]>;
  crossComponentAnalysis: {
    updaterPriorities: Record<string, JobPriority>;
    ...
  };
  storePathReads: Record<string, string[][]>;
}
```

分析对象：

- 模板表达式；
- computed 表达式；
- effect 语句块；
- Store 路径读取；
- 跨组件 props。

Store 路径只保留稳定前缀：

```ts
state.list[0].name      → list.0.name
state.list[index].name  → list
```

## 8. Slot 分配

`allocateComponentSlots` 给每个动态位置分配索引：

```ts
interface SlotAllocationIR {
  slots: Array<{
    slotIndex: number;
    type: SlotType;
    ...
  }>;
}
```

分配策略：

- 静态文本不分配；
- 动态文本分配 `text`；
- 每个动态 attribute 分配 `attribute` / `property`；
- 事件分配 `event`；
- 结构性节点分配 `if` / `for` / `dynamic` / `boundary` / ...；
- ref 分配 `ref`；
- 指令分配 `directive`。

## 9. Updater 生成

`generateComponentUpdaters` 按依赖与 Slot 组合生成：

| kind            | 运行时类               |
| --------------- | ---------------------- |
| `single-slot`   | `SimpleUpdater`        |
| `multi-slot`    | `MultiSlotUpdater`     |
| `condition`     | `ConditionUpdater`     |
| `effect`        | `EffectUpdater`        |
| `computed`      | 编译为 `single-slot`   |
| `event-binding` | 不进入 runtime updater |

生成结果：

```ts
interface UpdaterGenerationIR {
  updaters: Array<{
    name: string;
    kind: string;
    slotIndices: number[];
    dependencies: string[];
    expression: string;
    priority: JobPriority;
  }>;
}
```

## 10. Render Plan

`renderPlan` 汇总 codegen 需要的一切：

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

## 11. 代码生成

### CSR

`generateComponentRenderCode` 输出：

- 静态模板 hoist；
- `_renderAndMount()`；
- Slot 初始化；
- Updater 注册；
- 首轮写入；
- block payload。

### SSR

`generateSSRCode` 输出：

- `static render(props)`；
- `static renderStream(props)`；
- 服务端 marker；
- teleport / suspense patch。

### 类代码

`generateClassComponentCode` 组装：

```ts
class Counter extends ReactiveElement {
  static tagName = 'x-counter';
  static displayName = 'Counter';
  static propOptions = ...;
  static observedAttributes = ...;

  count = createSignal(0);

  static render(props) { ... }
  static renderStream(props) { ... }

  _renderAndMount() { ... }

  connectedCallback() { ... }
  disconnectedCallback() { ... }
}
```

dev + `hotReload` 时，字段初始化会被收进 `__laniaSetup()`，构造器调用它。

## 12. 模块输出

`emitFunctionComponentTsxModule` 组装最终模块：

```text
运行时前导 import
  + 用户业务 import
  + 被引用的模块级声明
  + 组件类
  + 默认 / 具名导出
```

规则：

- 只保留业务 import；
- 运行时能力统一从 `@lania-v/runtime` 解构；
- 未被引用的模块级声明不会进入产物；
- 组件类之间的引用顺序会处理 TDZ；
- 生成 sourcemap。

## 13. 插件钩子

```ts
interface CompilerPlugin {
  name: string;
  transformProgram?(program: CompilerProgram): void;
  transformTemplate?(component: ComponentIR): void;
  beforeAnalyzeComponent?(component: ComponentIR): void;
  afterAnalyzeComponent?(component: ComponentIR): void;
  afterGenerateArtifact?(artifact: ComponentCompilationArtifact): void;
}
```

执行顺序：

```text
transformProgram
  → transformTemplate
  → optimizeComponentTemplate
  → beforeAnalyzeComponent
  → analyzeComponentDependencies
  → afterAnalyzeComponent
  → allocateComponentSlots
  → generateComponentUpdaters
  → optimizeComponentUpdaters
  → generateComponentUpdaters
  → generateComponentRenderCode
  → afterGenerateArtifact
```

## 14. 诊断

错误统一包装成 `LaniaTsxCompileError`：

```ts
class LaniaTsxCompileError extends Error {
  fileName: string;
  line: number;
  column: number;
  frame: string;
}
```

Vite 插件会转换成 overlay 可消费的结构。

常见诊断：

- 增强组件父子约束；
- `html` 与 children 冲突；
- props 类型无法展开；
- `defineComponent` 选项字面量非法；
- 对象指令缺少必要字段；
- 未知增强组件名。

## 15. 调试入口

```ts
compileFunctionComponentTsx(fileName, source, { hotReload: true });
```

返回：

```ts
{
  className,
  classNames,
  program,
  componentAst,
  ir,
  renderCode,
  ssrCode,
  classCode,
  componentClasses,
}
```

可以直接检查 `ir.renderPlan`、`ir.slotAllocation`、`ir.updaterGeneration`。

## 下一步

- [更新链路](/advanced/update-pipeline)：生成出来的 Updater 如何执行。
- [编译期 API](/api/compile-time)：插件与入口签名。
