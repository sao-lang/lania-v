# FC 绑定视图与 Expose 说明

## 1. 这份文档是干嘛的

这份文档讲的是一组给 `FC / TSX` 用的辅助 API：

- `bindProps()`
- `bindHandlers()`
- `bindSlots()`
- `createExpose()`

目标不是搞一套新的组件模型，而是在不改现有 `props` / `slots` / `ref` / `emit` 语义的前提下，给函数组件补一层更顺手的访问面。

这份文档主要回答 5 个问题：

1. 这 4 个 API 分别解决什么问题。
2. 它们与当前 `props` / `slots` / `ref` / `emit` 的关系是什么。
3. 哪些能力可以纯 runtime 落地，哪些需要类型辅助。
4. 为什么选择 `bindHandlers` 而不是 `bindEmits`。
5. 这套东西现在落到了哪一步，后面还准备怎么收。

## 2. 当前落地状态

目前这 4 个 API 都已经在 runtime 里落地了：

- `bindProps()`
- `bindHandlers()`
- `bindSlots()`
- `createExpose()`

现在已经有的东西：

- runtime 已经能给函数组件提供这 4 个 API
- playground 已经有完整 demo
- `runtime-api.md` 已经补了对外说明
- 已经有针对函数组件路径的测试覆盖

当前版本可以直接用，但也有几个边界要先说清楚：

- `bindHandlers()` 现在优先吃内部 metadata，缺失时会回退到 `onXxx` 规则；
  `.lania.tsx` 编译产物会生成 `static handlerKeys`，所以 handler 值为空时也能正确分流
- `bindSlots()` 同时支持 runtime JSX scope 与编译后 Custom Element 两条路径：
  编译产物会改写成 `bindSlots(this.props)`，从 `children` prop 读取插槽内容
- `bindSlots().has(name)` 只判断具名槽本身是否存在，不再被默认槽兜底成 `true`
- `createExpose()` 已经能跟现有 `ref` 体系配合，也会在主卸载路径里自动清空
- scoped slot 已有运行时透传基础（函数型 slot + 额外参数），但 `.lania.tsx` 编译侧的完整 scoped slot 协议仍在收敛中

## 3. 为什么要做这个

其实当前 `FC / TSX` 主路径本来就已经有这些基础能力：

- 普通函数组件通过 `jsx()` 直接接收 `props` 对象。
- `children` 会通过 runtime scope 注入为 `slotContent`，供 `Slot` 等能力读取。
- `ref` / `createRef()` 已经存在，可承接 DOM、组件实例和函数 ref。
- `ReactiveElement` 已经有 `emit(name, detail)` 作为组件事件输出主路径。

但真正在组件里写代码的时候，还是有几个很明显的不顺手：

- 普通属性与回调型属性都堆在 `props` 上，访问面不够清晰。
- 插槽内容有正式协议，但没有一个与 `props` 对称的直接访问入口。
- 函数组件没有一套正式的“只暴露指定方法给父组件”的公开 API。
- 现有能力虽然能拼出来差不多的效果，但写起来不够统一。

## 4. 设计原则

- 运行时优先：先尽量建立在现有 runtime 能力上，不急着引入新的编译期宏。
- 兼容优先：`props.xxx`、`props.onXxx`、`<Slot />`、`ref={...}` 这些老写法都继续能用。
- 语义清晰：输入视图和输出视图分层明确，不混淆 `handlers` 与 `emit()`。
- 显式优先：能走内部稳定分类结果，就尽量不靠外部手写约定。
- 小步落地：先把 runtime helper 和基础类型补上，后面再看要不要继续增强。

## 5. API 总览

这次补的是这 4 个 API：

```ts
bindProps()
bindHandlers()
bindSlots(props?)
createExpose(props, exposed)
```

推荐写法：

```tsx
type PanelProps = {
  title: string;
  collapsed?: boolean;
  onToggle?: () => void;
  onSubmit?: (id: string) => void;
};

const Panel = defineComponent((props: PanelProps) => {
  // 不需要把 props 传进来，直接调用即可拿到普通属性与回调
  const p = bindProps<PanelProps>();
  const h = bindHandlers<PanelProps>();
  const slots = bindSlots();

  createExpose(props, {
    toggle: () => {
      h.onToggle?.();
    },
  });

  return (
    <section>
      <h1>{p.title}</h1>
      {slots.renderDefault('empty')}
    </section>
  );
});
```

## 6. API 分别是干嘛的

### 5.1 `bindProps()`

`bindProps()` 就是把函数组件收到的 `props` 再整理成一个“普通属性视图”。

可以这么理解：

- 它会自动把 handler 字段排掉
- 它不会改原始 `props`
- 你想继续写 `props.xxx` 也完全没问题

建议签名：

```ts
export function bindProps<T extends object>(): BoundProps<T>;
```

现在的实现语义：

- `bindProps()` 返回的是排掉 handler 之后的视图，不接受任何参数
- 始终读取当前组件的 props：
  - 未编译的函数组件由 JSX 运行时在调用组件时注入上下文；
  - 编译产物由编译器改写成内部工厂 `createBoundProps(this.props)`；
  - 构造期与 HMR 重跑 `setup` 期间也能拿到实例 props 快照。
- 组件上下文之外调用会直接报错
- 它和 `bindHandlers()` 共享同一份内部分类结果
- 现在走的是轻量视图，不是上来就深拷贝

### 5.2 `bindHandlers()`

`bindHandlers()` 用来拿“父组件传进来的回调”这部分视图。

这里故意叫 `handlers`，不叫 `emits`，因为这俩不是一回事：

- `handlers` 是父传回调输入
- `emit()` 是子组件往外派发事件
- 这两个方向不一样，不应该混成一个概念

建议签名：

```ts
export function bindHandlers<T extends object>(): BoundHandlers<T>;
```

现在的实现语义：

- `bindHandlers()` 返回从当前组件 props 自动分出来的 handler 视图，不接受任何参数
- 这个视图只负责读和调，不负责事件派发
- 用起来和 `props.onXxx` 没行为差异，只是更好收口
- `bindHandlers()` 与 `emit()` 不冲突：
  - `bindHandlers()` 是父传回调型输入视图
  - `emit()` 是子组件对外派发事件的输出

推荐主路径还是这样：

```ts
const h = bindHandlers();
h.onToggle?.();
props.onToggle?.();
```

### 5.3 `bindSlots()`

`bindSlots()` 用来读父组件传进来的插槽内容。

它优先复用当前 runtime scope 里的 `slotContent`；编译成 Custom Element 后没有
runtime scope，则从传入的 `props` 上读取 `children`。

签名：

```ts
export interface SlotBindings {
  has(name?: string): boolean;
  get(name?: string): unknown;
  render(name: string, fallback?: unknown, ...args: unknown[]): unknown;
  renderDefault(fallback?: unknown, ...args: unknown[]): unknown;
}

export function bindSlots(props?: { children?: unknown }): SlotBindings;
```

现在的实现语义：

- `get()` 返回原始 slot 内容
- `render()` 按当前 `Slot` 兼容层规则返回可渲染值
- `renderDefault()` 是默认插槽快捷方法
- named slot 还是按当前对象协议走
- `has(name)` 只检查具名槽本身，不把默认槽当成具名槽存在
- 编译产物里的 `bindSlots()` 会被改写成 `bindSlots(this.props)`

当前已经能确认的插槽边界：

- 已支持默认插槽。
- 已支持具名插槽的运行时取值，`render()` / `get()` 仍按
  `record[name] ?? record.default` 解析。
- 已支持 fallback。
- 已支持 Shadow DOM 宿主退化为原生 `<slot>`。
- 编译路径下 `children={object}` 的具名/默认插槽都能直接读取。
- 目前还没有正式的作用域插槽协议。

这里说“还没有正式的作用域插槽协议”，意思是：

- 当前 slot 传的是内容本身，不是那种“子组件传参给 slot 函数”的正式协议
- 现在出现的函数更像“无参懒执行内容”，不是 `slotProps => children` 这种 scoped slot 形态
- 所以 `bindSlots()` 这一期只包默认槽和具名槽，不默认把 scoped slot 也算进去

示例：

```tsx
const Layout = defineComponent((props: { title: string }) => {
  const slots = bindSlots();

  return (
    <section>
      <header>{slots.render('header', 'default header')}</header>
      <main>{slots.renderDefault('default body')}</main>
    </section>
  );
});
```

### 5.4 `createExpose()`

`createExpose()` 就是让函数组件显式声明“我要通过 ref 暴露给父组件什么东西”。

它不是要替代类组件实例 ref，而是给函数组件补一条正式的 imperative 输出路径。

建议签名：

```ts
export function createExpose<T extends object>(
  props: {
    ref?: T | import('@lania-v/runtime').RefBinding<T> | null | undefined;
  },
  exposed: T
): T;
```

现在的实现语义：

- 只对函数组件生效
- 通过现有 `ref` 基础设施把 `exposed` 写进父组件 ref
- `exposed` 是公开面，不等于组件内部全部状态
- 多次渲染时会以最后一次结果为准
- 组件卸载时会自动把 ref 置回 `null`

示例：

```tsx
type InputExpose = {
  focus(): void;
  clear(): void;
};

const Input = defineComponent((props: { ref?: InputExpose }) => {
  const inputRef = createRef<HTMLInputElement>();

  createExpose(props, {
    focus: () => {
      inputRef?.focus();
    },
    clear: () => {
      if (inputRef) {
        inputRef.value = '';
      }
    },
  });

  return <input ref={inputRef} />;
});
```

## 7. 和现有能力是什么关系

### 6.1 与 `props`

- `bindProps()` 不是来替代 `props` 的
- `props.xxx` 和 `props.onXxx` 继续都能写
- 它只是补了一个更清晰的普通属性视图

### 6.2 与 `emit()`

- `bindHandlers()` 不是拿来替代 `emit()` 的
- `bindHandlers()` 管的是父传回调输入
- `emit()` 还是组件对外派发事件的正式主路径

因此两种模型可以并存：

```tsx
h.onSubmit?.('42');
props.onSubmit?.('42');
this.emit('submit', '42');
```

简单说：

- `h.onSubmit?.('42')` 和 `props.onSubmit?.('42')` 等价，只是访问面更清楚
- `this.emit('submit', '42')` 还是事件输出主路径，和前两者不冲突

### 6.3 与 `Slot`

- `bindSlots()` 不替代 `<Slot />`
- `<Slot />` 继续是模板里的占位语义
- `bindSlots()` 提供的是逻辑层直接读取接口
- 当前主要覆盖默认插槽、具名插槽和 fallback
- scoped slot 还是后续能力，这一版先不默认承诺

### 6.4 与 `ref`

- `createExpose()` 建立在现有 `ref` / `createRef()` 之上
- 类组件和自定义元素组件继续可以直接走实例 ref
- 函数组件通过 `createExpose()` 收出一份更受控的公开面

## 8. 现在到底是怎么落地的

### 8.1 `bindProps()`

状态：已实现

现在的做法：

- 函数组件本来就直接收到 `props`，runtime 在调用组件前把它设为当前 props 上下文
- 直接从上下文取 props；编译器会把 `.lania.tsx` 里的调用改写成
  `createBoundProps(this.props)`，覆盖手动创建 / SSR 升级 / HMR 场景
- runtime 会基于 `props` 和内部 handler 分类结果建一个视图
- 整体是纯 runtime 落地，编译器只补一个实参

### 8.2 `bindHandlers()`

状态：已实现

现在的做法：

- 父传回调本来就在 `props` 上
- `bindHandlers()` 与 `bindProps()` 共用同一份 props 上下文解析
- 直接复用和 `bindProps()` 同一份分流结果
- 优先走内部 metadata，缺失时再回退到 `onXxx` 规则
- 手动创建的元素会从类上的 `static handlerKeys` 补齐 metadata，回调尚未赋值也能稳定分流

当前约束：

- 用户侧不需要手动传 handler keys
- 框架内部要保证分类结果稳定可复用

### 8.3 `bindSlots()`

状态：已实现

现在的做法：

- 直接从当前 runtime scope 里拿 `slotContent`
- 复用现有 `Slot` 的读取和渲染规则
- 本质上就是补了一层更顺手的读取包装

### 8.4 `createExpose()`

状态：已实现

现在的做法：

- 复用现有 `ref` / `createRef()` / `setRef()` 基础设施
- 暴露对象直接走现有 ref 通道传给父组件
- 主卸载路径里会自动把 ref 清回 `null`

当前还要继续观察的点：

- 函数组件多次执行时 expose 对象的更新时间点
- 在不引入新实例模型的前提下，把挂载、更新、卸载时序收得更稳

## 9. 运行时设计

### 8.1 `bindProps()` / `bindHandlers()`

当前实现走的是轻量对象视图：

- 输入还是原始 `props`
- 先生成一份共享的 handler 分类结果，再派生 props 视图和 handler 视图
- 默认不做深拷贝

内部分类结果优先级：

1. 优先读取编译期或 JSX 运行时写入的隐藏 metadata
2. metadata 缺失时再退回运行时约定规则

换句话说：

- 用户侧不需要手动传 key
- `bindProps()` 和 `bindHandlers()` 必须拿到同一份分流结果
- 这份分流结果是内部协议，不往外暴露

之前讨论过的候选方案：

- 直接构建浅对象快照
- `Proxy`
- `Object.defineProperty` getter 视图
- props 隐藏 metadata + getter 视图

当时的优先级判断：

1. 浅对象快照：实现最简单，但更新后不自动反映最新值。
2. `Proxy`：语义最直接，但需评估体积与调试体验。
3. getter 视图：兼顾轻量与按需读取。
4. hidden metadata + getter 视图：最符合“自动分流且不要求用户传 key”的目标，推荐作为主方案。

现在已经落地成：

- `bindProps()` / `bindHandlers()` 使用共享分类结果 + getter 视图
- 在函数组件单次执行上下文里按本次 `props` 构建视图

### 8.2 `bindSlots()`

运行时读取源按入口分两种：

- runtime JSX 路径：通过 `getCurrentRuntimeScope()` 获取 `slotContent`
- 编译后 Custom Element 路径：使用 `props.children`（编译器会注入 `bindSlots(this.props)`）

两条路径最后都复用同一套 named slot 解析与可渲染值归一化逻辑。

当前能力判断：

- 默认插槽和具名插槽可以直接建立在现有 `slotContent` / `children` 协议上
- scoped slot 还不能只靠当前 `slotContent` 直接成立，因为缺少正式的传参协议

如果后面要补 scoped slot，建议单独加一层 slot 调用协议，比如：

- `slots.render(name, slotProps, fallback)`
- `slots.call(name, slotProps)`
- 或在 `slotContent` 中显式区分“普通内容”与“slot 函数”

这一期先不做：

- 顺手把 scoped slot 一起做掉
- 为 slot 内容再引入第二套类型模型

### 8.3 `createExpose()`

运行时流程很直接：

1. 从 `props.ref` 读取 ref binding
2. 把 `exposed` 写入该 ref
3. 组件销毁时写回 `null`

实现上就是：

- 对象 ref 就写 `current`
- 函数 ref 就直接回调（编译组件里的 `ref={panelRef}` 会被改写成这种函数）
- 多次渲染时以最后一次 `createExpose()` 调用结果为准
- 子组件没有暴露面时，父组件 ref 会退回宿主元素

这一期先不做：

- 为函数组件额外引入持久实例对象
- 为 expose 单独设计第二条宿主生命周期链

## 10. 类型设计

### 9.1 `bindProps()` / `bindHandlers()`

用户侧不传 key，所以类型设计也跟着自动分流走：

```ts
const p = bindProps<PanelProps>();
const h = bindHandlers<PanelProps>();
```

类型层的目标：

- `p` 代表普通属性视图
- `h` 代表 handler 视图
- 两者共享同一套分类规则

这一版先保证运行时语义和基础类型可用。
如果后面需要更精确的静态类型，再考虑通过 JSX 类型扩展或内部 metadata 映射继续增强。

### 9.2 `bindSlots()`

这一版 `bindSlots()` 的类型先不追求“精确到每个 slot 名”，先保持宽类型：

```ts
interface SlotBindings {
  has(name?: string): boolean;
  get(name?: string): unknown;
  render(name: string, fallback?: unknown, ...args: unknown[]): unknown;
  renderDefault(fallback?: unknown, ...args: unknown[]): unknown;
}
```

如果后面真的需要 named slot 类型增强，再单独设计静态契约。
作用域插槽类型也等正式协议定下来再补，不急着在现在就把函数签名锁死。

### 9.3 `createExpose()`

`createExpose<T>()` 的关键点就两个：

- `ref` 目标类型等于 `T`
- 父组件通过 `createRef<T>()` 获得同一公开面类型

示例：

```ts
const panelRef = createRef<{ open(): void; close(): void }>();
```

## 11. 编译器影响

这套方案对编译器的要求尽量保持很小，但 `bindProps()` / `bindHandlers()` 的“自动分流”还是需要框架内部有统一分类来源：

- `bindProps()`
- `bindHandlers()`
- `bindSlots()`
- `createExpose()`

其中：

- `bindSlots()` 与 `createExpose()` 可以优先按公共 runtime API 设计。
- `bindProps()` 与 `bindHandlers()` 虽然面向 runtime，但需要框架内部约定一份统一的 handler 分类结果。

原因也很直接：

- 这组 API 本质上就是函数组件内部的访问便利层
- 当前 runtime 已经有 `props`、`slotContent`、`ref` 这些基础信息
- `bindProps()` / `bindHandlers()` 的关键不在能不能访问 `props`，而在怎么拿到稳定的自动分流结果
- 太早把它们做成 compile-only 会增加维护面，但完全不建内部分类协议也满足不了目标

所以当前策略是：

- 对外还是 runtime API
- 对内允许复用编译链或 JSX 运行时已有的事件分类结果
- 只有后面真需要更精确类型或更稳的跨入口一致性时，再考虑编译器增强

## 12. 编译后的 Custom Element 路径

`.lania.tsx` 编译成 Custom Element 后，组件不再有 runtime slot scope，
`props` 也变成构造期快照。为了保持这组 API 的行为一致，编译链补了三处桥接：

1. 注入的 `props` 字段改为 `createComponentPropsSnapshot(this, [...])`：
   - key 集合覆盖所有声明过的 prop；
   - 已声明的 prop 通过 getter 回读实例上的同名 prop signal，
     `bindProps()` 读取时仍能正常收集依赖；
   - 从原始入参继承 handler metadata。
2. prop setter 同步写回 `this.props`，并改用 `signal.setValue()`：
   - `bindProps()` / `bindHandlers()` 的 getter 视图能读到最新值；
   - `onToggle` 这类函数值不会被误当成 signal 的 updater 回调执行。
3. 类上生成 `static handlerKeys`，`createComponentElement()` 在构造前挂 metadata：
   - `bindHandlers()` 即使当前 handler 为空也能拿到稳定的 key 集合。
4. 编译器改写零参调用：
   - `bindSlots()` → `bindSlots(this.props)`，插槽内容从 `children` prop 读取，
     父组件 `children={object}` 的具名/默认槽都能命中；
   - `bindProps()` → `createBoundProps(this.props)`、`bindHandlers()` →
     `createBoundHandlers(this.props)`，业务侧签名保持无参；
   - 手动 `document.createElement()` 与 SSR 升级时同样能拿到构造期 props 快照。

对应测试在 `tests/compiled-component-runtime.test.ts`，走真实编译 + CommonJS 求值 + jsdom。

## 13. 兼容策略

- 不移除 `props.xxx`。
- 不移除 `props.onXxx`。
- 不移除 `<Slot />`。
- 不移除 `ref={...}`。
- 不改变 `emit(name, detail)` 的现有事件主路径。

这组 API 是新增能力，不是替换性迁移。

## 14. 后面还可以继续补什么

### 已经完成

- 已新增 `bindProps()`
- 已新增 `bindHandlers()`
- 已新增 `bindSlots()`
- 已新增 `createExpose()`
- 已补最小测试与 playground 样例
- 已补 `runtime-api.md`

### 后续可选增强

- 看要不要给 `bindHandlers()` 补更好的类型推导
- 看要不要给 `bindSlots()` 补 named slot 类型契约
- 看要不要把 `createExpose()` 和函数组件 ref 的时序再收紧一点
- 看要不要单独设计 scoped slot 的正式协议

## 15. 明确不做

- 不把 `bindHandlers()` 命名成 `bindEmits()`
- 不把 handler 视图与 `emit()` 语义合并
- 不要求业务手动传 handler keys
- 不把 `createExpose()` 设计成新的组件实例系统
- 不为这组 API 引入新的 TSX 宏入口

## 16. 一句话结论

推荐组合就是：

```ts
bindProps()
bindHandlers()
bindSlots()
createExpose(props, exposed)
```

分别解决的是：

- 普通属性访问面
- 回调型输入访问面
- 插槽内容访问面
- 函数组件公开方法面

这套 API 和当前 `FC / TSX` 主路径是兼容的，而且现在已经能以 runtime API 形式直接用起来，不需要先上新的编译期宏。
