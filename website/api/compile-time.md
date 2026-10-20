# 编译期 API

这一页分两部分：

1. **compile-only API**：写在 `.lania.tsx` 里，由编译器改写；
2. **编译器入口**：直接调用 `@lania-v/compiler-tsx` / `@lania-v/compiler-core`。

## 什么是 compile-only

有些 API 只在源码层面有意义：

```tsx
onMount(() => {
  /* ... */
});
provideContext(ThemeContext, theme);
useFormValue(() => account());
const inputRef = createRef<HTMLInputElement>();
```

它们不会作为普通函数执行，而是作为“标记”被编译器识别并改写。公共运行时仍然导出同名函数，但直接调用会抛错：

```text
onMount() is compile-time only. It must be rewritten by the Lania compiler
inside a compiled component instead of running in the public runtime directly.
```

这样设计的原因：

- 避免静默 no-op；
- 明确错误边界；
- 让类型提示和行为保持一致。

## 生命周期标记

### `onMount()`

```ts
onMount(callback: () => void): void
onMounted(callback: () => void): void // 别名
```

编译后进入 `__fcOnMount()`：

```ts
protected __fcOnMount(): void {
  callback();
}
```

`__fcOnMount()` 在 `connectedCallback()` 中、首屏挂载之前执行。

```tsx
onMount(() => {
  console.log('mounted');
});
```

### `onCleanup()`

```ts
onCleanup(callback: () => void): void
onUnmounted(callback: () => void): void // 别名
```

编译后进入 `__fcOnCleanup()`：

```ts
protected __fcOnCleanup(): void {
  callback();
}
```

在 `disconnectedCallback()` 中执行。

```tsx
onCleanup(() => {
  controller.abort();
});
```

### `onUpdated()`

```ts
onUpdated(callback: (changedProps: ChangedProps) => void): void
```

编译后进入 `__fcOnUpdated(changedProps)`，在 `updated()` 之后执行。

```tsx
onUpdated((changedProps) => {
  console.log([...changedProps.keys()]);
});
```

### 为什么不支持返回清理函数

`onMount` 的编译产物是 `__fcOnMount(): void`，返回值会被丢弃。清理逻辑请使用 `onCleanup()`。

## 上下文标记

实践用法见 [上下文（Context）](/guide/context)。

### `provideContext()`

组件体内的两参形式是编译期语法糖：

```ts
provideContext<T>(
  context: Context<T>,
  value: ContextValueProvider<T>
): () => void
```

编译改写：

```ts
provideContext(ThemeContext, theme);
// →
provideContext(this, ThemeContext, theme);
```

- `this` 是当前组件宿主；
- 必须在编译组件内使用；
- 运行时直接调用两参形式会抛错，请改用 `provideContext(host, context, value)`。

## 表单标记

### `useFormValue()`

```ts
useFormValue(getter: () => unknown): void
```

编译产物：

```ts
static formAssociated = true;

// effect updater（priority 固定为 low）
const runEffect___formValue = new EffectUpdater(
  () => {
    this._setFormValue(this.account());
  },
  'low',
  this._scheduler
);
runEffect___formValue.deps.add(this.account);
this.registerRuntimeUpdater(runEffect___formValue);
```

因此：

- 组件会出现在 `form.elements`；
- `FormData` 会带上当前值；
- `getter` 必须在编译期可识别为单表达式。

支持的写法：

```tsx
useFormValue(() => account());
useFormValue(() => {
  return account();
});
```

不支持的写法：

```tsx
useFormValue(() => {
  const value = account();
  return value;
});
```

### `useFormValidity()`

```ts
useFormValidity(
  getter: () => boolean | { valid: boolean; message?: string } | null | undefined
): void
```

编译产物：一个 EffectUpdater，依赖变化时调用 `_setFormValidity(getter())`。

```tsx
useFormValidity(() =>
  valid() ? true : { valid: false, message: '请输入有效值' }
);
```

## 编译改写规则

### Signal / Memo / Effect

| 源码                                           | 编译后                                                    |
| ---------------------------------------------- | --------------------------------------------------------- |
| `const count = createSignal(0)`                | 实例字段 `count = createSignal(0)`                        |
| `const double = createMemo(() => count() * 2)` | `double = createComputedAccessor(() => this.count() * 2)` |
| `createEffect(() => {...})`                    | `EffectUpdater`，随组件 attach / detach                   |

注意：

- `createMemo` 在编译组件里不再缓存；
- 模板依赖由编译器静态注入；
- `watch()` 不会被改写。

### Props

| 源码                               | 编译后                             |
| ---------------------------------- | ---------------------------------- |
| `props.title`                      | `this.title`                       |
| `const { title } = props`          | `this.title`                       |
| `const { count: total } = props`   | `this.count`（`total` 为本地别名） |
| `const { user: { name } } = props` | `this.user?.name`                  |
| `const { title = 'x' } = props`    | `(this.title ?? 'x')`              |
| `...rest`                          | `this.rest`                        |

#### 支持的 props 类型

- 内联对象类型；
- 同文件 `type` / `interface`（含 `extends`）；
- 交叉类型；
- 相对路径导入的具名类型。

#### 不支持的 props 类型

- 包名或路径别名导入；
- `Pick<T, K>`、泛型实例化等需要类型检查器展开的形态；
- 计算属性名。

替代写法：

```tsx
<div>{props.title ?? 'fallback'}</div>
<div>{props.user?.name}</div>
```

### 本地声明与解构

除响应式工厂外，函数体顶层的本地声明都会提升为实例字段，模板里的裸引用会改写成 `this.<name>`：

| 源码                                         | 编译后                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `const count = createAtom(0)`                | `count = createAtom(0)`，引用变为 `this.count`                                              |
| `const { pending, start } = useTransition()` | 临时字段 `__setup_object_0 = useTransition()`，`pending = this.__setup_object_0["pending"]` |
| `const { a: alias, ...rest } = source`       | `alias` / `rest` 各自成为实例字段，`source` 只求值一次                                      |
| `const [first, second] = pair()`             | `__setup_tuple_0 = pair()`，元素按索引取字段                                                |

注意：

- 解构右值只会执行一次，避免重复调用产生新的引用；
- 支持别名、嵌套对象解构与 rest 元素；计算属性名和数组解构嵌套暂不支持；
- `props` 解构是特例，仍走上面的 Props 表中的响应式替换逻辑。

### 事件

| 源码                                 | 编译后                                       |
| ------------------------------------ | -------------------------------------------- |
| `onClick={fn}`                       | DOM event slot                               |
| `onKeyDown={fn}`                     | DOM `keydown` 事件 slot（事件名转小写）      |
| `onToggle={fn}`（组件标签）          | 组件事件 `toggle`                            |
| `onClick={ { handler, modifiers } }` | 带修饰符的事件 slot                          |
| `onClick={ { handler, listener } }`  | 带原生监听选项、不走委托的事件 slot          |
| `on:close={fn}`                      | 组件事件 `close`（`directive-extended`）     |
| `onClick.stop={fn}`                  | DOM `click` + `stop`（`directive-extended`） |

### 指令

| 源码                              | 编译后                                          |
| --------------------------------- | ----------------------------------------------- |
| `model={ { target } }`            | `ModelBindingSlot`                              |
| `html={html\`...\`}`              | HTML slot                                       |
| `ref={ref}`                       | `RefSlot`（`createRef()` 声明时改写为字段赋值） |
| `use={ { name: value } }`         | `UseDirectiveSlot`                              |
| `class={...}` / `className={...}` | ClassSlot / AttrSlot                            |
| `style={...}`                     | StyleSlot / StyleObjectSlot                     |

### 生命周期

| 源码            | 编译后                        |
| --------------- | ----------------------------- |
| `onMount(fn)`   | `__fcOnMount()`               |
| `onCleanup(fn)` | `__fcOnCleanup()`             |
| `onUpdated(fn)` | `__fcOnUpdated(changedProps)` |

## `@lania-v/compiler-tsx`

### `compileFunctionComponentTsx()`

```ts
compileFunctionComponentTsx(
  fileName: string,
  source: string,
  options?: CompilerPluginOptions,
  mode?: TsxTemplateSyntaxMode
): CompiledTsxFunctionComponent
```

流程：

1. `parseFunctionComponentTsx(fileName, source, mode)`；
2. `runComponentCompilerPipeline(program, options)`；
3. `generateClassComponentCode()` 为每个组件生成类代码；
4. 返回入口组件与所有组件产物。

示例：

```ts
import { compileFunctionComponentTsx } from '@lania-v/compiler-tsx';

const result = compileFunctionComponentTsx(
  'Counter.lania.tsx',
  `
  import { createSignal, defineComponent } from '@lania-v/runtime';

  export default defineComponent(function Counter() {
    const count = createSignal(0);
    return <button onClick={() => count.set((v) => v + 1)}>{count()}</button>;
  });
  `
);

result.ir.renderPlan;
result.ir.slotAllocation;
result.ir.updaterGeneration;
```

### `CompiledTsxFunctionComponent`

```ts
interface CompiledTsxFunctionComponent {
  className: string;
  classNames: string[];
  program: CompilerProgram;
  componentAst: ComponentDeclaration;
  ir: ComponentIR;
  staticHtml: string;
  textBindings: TsxFunctionTextBindingPlan[];
  renderCode: RenderCodegenResult;
  ssrCode: SSRCodegenResult;
  classCode: ClassComponentCodegenResult;
  componentClasses: Array<{
    className: string;
    classCode: ClassComponentCodegenResult;
  }>;
}
```

| 字段               | 用途                                  |
| ------------------ | ------------------------------------- |
| `className`        | 入口组件类名（`export default` 指向） |
| `classNames`       | 文件内所有组件类名                    |
| `program`          | 统一 `CompilerProgram`                |
| `componentAst`     | 入口组件的 AST 声明                   |
| `ir`               | 入口组件 `ComponentIR`                |
| `staticHtml`       | 静态模板 HTML                         |
| `textBindings`     | 文本绑定计划                          |
| `renderCode`       | CSR 代码生成结果                      |
| `ssrCode`          | SSR 代码生成结果                      |
| `classCode`        | 入口组件类代码                        |
| `componentClasses` | 每个组件的类代码                      |

### `compileFunctionComponentTsxToModule()`

```ts
compileFunctionComponentTsxToModule(
  fileName: string,
  source: string,
  options?: CompilerPluginOptions,
  mode?: TsxTemplateSyntaxMode
): string
```

返回最终模块代码字符串，不包含 sourcemap。适合简单集成。

### `compileFunctionComponentTsxModule()`

```ts
compileFunctionComponentTsxModule(
  fileName: string,
  source: string,
  options?: CompilerPluginOptions,
  mode?: TsxTemplateSyntaxMode
): CompiledTsxModule
```

```ts
interface CompiledTsxModule {
  code: string;
  map: ReturnType<MagicString['generateMap']>;
  compiled: CompiledTsxFunctionComponentModule;
}
```

Vite 插件使用的就是它。

### `emitFunctionComponentTsxModule()`

```ts
emitFunctionComponentTsxModule(
  fileName: string,
  source: string,
  compiled: CompiledTsxFunctionComponent
): CompiledTsxFunctionComponentModule
```

模块输出负责：

- 保留业务 import；
- 注入运行时前导；
- 保留被引用的模块级声明；
- 拼接组件类；
- 生成默认 / 具名导出。

未被引用的模块级声明不会进入产物。需要复用的辅助逻辑请放到兄弟 `.ts` 文件。

### `createCompiledTsxModuleMap()`

```ts
createCompiledTsxModuleMap(
  fileName: string,
  source: string,
  moduleCode: string
): ReturnType<MagicString['generateMap']>
```

生成整段替换式 sourcemap。

### `TsxTemplateSyntaxMode`

```ts
type TsxTemplateSyntaxMode = 'jsx-standard' | 'directive-extended';
```

| 模式                 | 支持                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `jsx-standard`       | 标准 JSX；`model={ {...} }`、`html={...}`、`className`、对象事件                              |
| `directive-extended` | 额外兼容 `model:value.trim`、`style:width.px`、`class:active`、`use:name`、`click.stop`、`if` |

### 其他导出

```ts
createTsxCompiler(): { name: 'compiler-tsx' }

parseFunctionComponentTsx(...)
analyzeTsxBindingName(...)
escapeBindingNameForTsxParser(...)
unescapeBindingNameFromTsxParser(...)
```

## `@lania-v/compiler-core`

### `runComponentCompilerPipeline()`

```ts
runComponentCompilerPipeline(
  program: CompilerProgram,
  options?: CompilerPluginOptions
): CompilerPipelineResult
```

```ts
interface CompilerPipelineResult {
  program: CompilerProgram;
  components: Array<{
    component: ComponentIR;
    renderCode: RenderCodegenResult;
  }>;
}
```

阶段顺序：

```text
applyProgramPlugins
  → lowerProgramToComponentIR
  → applyTemplateTransformPlugins
  → optimizeComponentTemplate
  → applyBeforeAnalyzePlugins
  → analyzeComponentDependencies
  → applyAfterAnalyzePlugins
  → allocateComponentSlots
  → generateComponentUpdaters
  → optimizeComponentUpdaters
  → generateComponentUpdaters
  → generateComponentRenderCode
  → applyArtifactPlugins
```

### `CompilerPlugin`

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

| Hook                     | 适合做什么           |
| ------------------------ | -------------------- |
| `transformProgram`       | 全局扫描、注入元信息 |
| `transformTemplate`      | 改写模板 IR          |
| `beforeAnalyzeComponent` | 补充分析输入         |
| `afterAnalyzeComponent`  | 读取 / 修正分析结果  |
| `afterGenerateArtifact`  | 采集统计、产物后处理 |

示例：

```ts
import type { CompilerPlugin } from '@lania-v/compiler-core';

const statsPlugin: CompilerPlugin = {
  name: 'stats',
  afterAnalyzeComponent(component) {
    console.log(component.name, {
      signals: component.signals.length,
      updaters: component.updaterGeneration.updaters.length,
    });
  },
  afterGenerateArtifact(artifact) {
    console.log('generated', artifact.component.name);
  },
};

laniaFcVitePlugin({ compilerPlugins: [statsPlugin] });
```

### `ComponentIR`

```ts
interface ComponentIR {
  type: 'ComponentIR';
  name: string;
  sourceKind: CompilerProgram['sourceKind'];
  props: PropIR[];
  signals: SignalIR[];
  computed: ComputedIR[];
  effects: EffectIR[];
  lifecycle: LifecycleIR;
  lifecycleCallbacks: LifecycleCallbackIR[];
  setupBindings: SetupBindingIR[];
  template: TemplateIR;
  formAssociated?: boolean;
  optionsSource?: string;
  renderPlan: ComponentRenderPlanIR;
  optimizationPass: OptimizationPassIR;
  dependencyAnalysis: DependencyAnalysisIR;
  slotAllocation: SlotAllocationIR;
  updaterGeneration: UpdaterGenerationIR;
}
```

### 其他入口

```ts
createCompilerCore(): { name: 'compiler-core' }

lowerProgramToComponentIR(program: CompilerProgram): ComponentIR[]
optimizeComponentTemplate(component: ComponentIR): void
optimizeComponentUpdaters(component: ComponentIR): void
analyzeComponentDependencies(component: ComponentIR): DependencyAnalysisIR
allocateComponentSlots(component: ComponentIR): SlotAllocationIR
generateComponentUpdaters(component: ComponentIR): UpdaterGenerationIR
generateComponentRenderCode(component: ComponentIR): RenderCodegenResult
```

## 诊断

编译错误统一包装为 `LaniaTsxCompileError`：

```ts
class LaniaTsxCompileError extends Error {
  fileName: string;
  line: number;
  column: number;
  frame: string;
}
```

Vite 插件会转换成：

```ts
{
  id: fileName,
  message,
  frame,
  loc: { file, line, column },
}
```

常见错误：

- `<Then>` / `<Else>` / `<Case>` / `<Default>` 父子关系错误；
- `html` 与 children 同时出现；
- `model` 对象缺少 `target` / `source`，或两者同时出现；
- `use` / `model` / 对象事件不是静态对象字面量；
- props 类型无法展开；
- 未知 prop 或未知选项。

## 直接调用编译器的注意事项

- 输入必须是完整 `.lania.tsx` 源码；
- `fileName` 会影响诊断与 sourcemap；
- 编译产物依赖 `@lania-v/runtime` 与 `@lania-v/shared`；
- 生产构建建议通过 Vite 插件，而不是手工调用编译器；
- 模块输出会丢弃未被引用的模块级声明。
