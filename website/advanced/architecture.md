# 整体架构

`lania-v` 把工作分成三层：**作者层**、**编译层**、**运行层**。

```text
Authoring         FC / TSX（.lania.tsx）

Compiler          Parse → AST → Component IR → Dependency Analysis
                  → renderPlan → Codegen

Runtime           ReactiveElement → Signal / Computed / Effect
                  → Scheduler → Updater → Slot → DOM

Integration       Vite Plugin / HMR / Devtools / SSR
```

## 包结构

```text
packages/
├── runtime/
│   ├── reactivity/     Signal、Computed、Effect、Store、Resource、Scheduler
│   ├── dom/            Slot、Updater、指令、class/style/html 绑定
│   ├── render/         DOM 渲染、SSR、DSD、Hydration
│   ├── component/      组件宿主、增强组件、生命周期、Transition
│   ├── core/           Context、Debug、Devtools、Env
│   ├── dev/            HMR
│   └── entry/          公共入口
├── compiler-core/
│   ├── ast/            统一 AST
│   ├── ir/             Component IR、模板 lowering、Render Bindings
│   ├── analysis/       依赖分析、跨组件分析
│   ├── plan/           Slot 分配、Updater 生成
│   ├── codegen/        Render / SSR 代码生成
│   ├── transform/      模板与表达式优化
│   ├── diagnostics/    错误定位
│   └── pipeline/       管线与插件
├── compiler-tsx/
│   ├── syntax/         TSX 预处理
│   ├── parse/          函数组件、模板、表达式解析
│   ├── analysis/       绑定名分析
│   └── compile/        编译入口与模块输出
├── vite-plugin/        文件过滤、编译调用、HMR
└── shared/             增强组件注册表、payload 协议、版本
```

## 作者层

作者只写 `.lania.tsx`：

```tsx
export default defineComponent(function Counter() {
  const count = createSignal(0);
  return <button onClick={() => count.set((v) => v + 1)}>{count()}</button>;
});
```

作者层不接触：

- Slot 索引；
- Updater；
- DOM 操作；
- SSR 标记。

## 编译层

### `compiler-tsx`

负责把 `.lania.tsx` 变成 `CompilerProgram`：

1. `syntax/tsx-binding`：把扩展绑定名预处理成合法 TSX；
2. `parse/function`：解析 `defineComponent`、props、signals、computed、effects、lifecycle；
3. `parse/template`：把 JSX 转成 `TemplateNode`；
4. `analysis/binding`：把 attribute 分类为普通属性、事件、指令；
5. `compile`：调用 compiler-core 管线，组装模块输出。

### `compiler-core`

负责协议无关的编译：

1. `lowerProgramToComponentIR`：AST → `ComponentIR`；
2. `optimizeComponentTemplate`：静态提升、常量折叠；
3. `analyzeComponentDependencies`：Signal / Store 依赖；
4. `allocateComponentSlots`：给每个动态位置分配 Slot；
5. `generateComponentUpdaters`：按依赖合并 Updater；
6. `generateComponentRenderCode`：生成 `_renderAndMount()`；
7. `generateSSRCode`：生成 `static render()` / `static renderStream()`。

### `shared`

编译器与运行时共享：

- 增强组件注册表（谁支持 SSR、落到哪类 IR）；
- payload 协议（`lania.enhanced` / `0.1-draft`）；
- 版本常量。

## 运行层

### `ReactiveElement`

每个编译组件都继承它：

```ts
abstract class ReactiveElement extends HTMLElement {
  static renderMode: 'shadow' | 'light';
  static hydration: 'eager' | 'manual';
  static styles?: StaticStyles;
  static propOptions?: PropOptionsMap;

  protected renderRoot!: ShadowRoot | this;
  protected _slots: Node[] = [];
  protected _updaters: Array<() => void> = [];
  protected _runtimeUpdaters: Updater[] = [];
  protected _slotTable = new SlotTable();

  protected abstract _renderAndMount(): void;
}
```

职责：

- 创建 render root；
- 注入样式；
- 挂载首屏；
- 绑定 / 解绑 Signal 与 Updater；
- 调度更新；
- 触发生命周期；
- 处理表单关联。

### Signal / Scheduler

```text
createSignal
  → set()
  → scheduler.scheduleSignal(updater.job)
  → microtask flush
```

Scheduler 把任务分成：

- 普通队列（按优先级分桶）；
- lifecycle 队列；
- effect 队列；
- unit-of-work 队列（分片）。

### Slot / Updater

```text
Updater.compute()
  → Updater.commit()
  → Slot.write()
  → DOM
```

Slot 只负责写一个位置。Updater 只负责算值并写自己负责的 Slot。

## 一条完整链路

```text
用户点击按钮
  → onClick handler
  → count.set(1)
  → signal.updaters 中的 job 入队
  → scheduler.flush()
  → updater.run()
  → compute() 得到新文本
  → commit()
  → TextSlot.write()
  → textNode.data = 'count: 1'
```

没有组件重渲染，没有 VNode 比较。

## 增强组件的位置

增强组件跨越编译层与运行层：

```text
<When> / <Each> / <Teleport> ...
  → compiler-core 识别
  → 下沉为 IfIR / ListIR / TeleportIR ...
  → codegen 生成 block payload
  → runtime 的 Slot / Boundary / Transition host 执行
```

因此它们不是“普通函数组件”，不能像普通组件那样随意嵌套。

## 设计边界

- 运行时不做依赖追踪来决定模板更新；
- 编译器不做 DOM 操作；
- Slot 不关心业务语义；
- 增强组件通过共享协议跨包通信；
- 所有共享状态（KeepAlive、Suspense、Transition）都有测试重置入口。

## 下一步

- [更新链路](/advanced/update-pipeline)：调度器内部顺序。
- [编译管线](/advanced/compiler-pipeline)：每个编译阶段的输入输出。
