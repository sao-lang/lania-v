# 语法参考

这一页是 `.lania.tsx` 的**语法清单**：文件规则、表达式规则、全部属性形态、两种语法模式的对照，以及编译器会直接拒绝的写法。

各项绑定的运行时语义（例如 class 的归一化顺序、style 的覆盖规则、指令的生命周期）见 [模板与绑定](/guide/templates)。

## 文件与模块

| 规则 | 说明 |
| --- | --- |
| 扩展名 | 必须是 `.lania.tsx`，由 Vite 插件按 `tsxInclude` 拦截 |
| 组件声明 | 每个 `defineComponent(...)` 调用编译出一个继承 `ReactiveElement` 的类 |
| 默认导出 | 默认导出就是该组件类；父组件用 `import Card from './Card.lania.tsx'` 引入 |
| 返回值 | 组件函数必须返回**单个** JSX 元素或 fragment（`<>...</>`） |
| 多个组件 | 一个文件可以定义多个组件，未导出组件的标签名按声明推断 |
| 辅助函数 | 放在 `.ts` 文件里再 import；模块输出只保留被编译产物引用到的声明 |

多个根节点会被拒绝：

```tsx
return (<p>a</p><p>b</p>);   // ❌ component must return a JSX element or fragment
return (<><p>a</p><p>b</p></>); // ✅
```

## 组件函数的两个区域

```tsx
export default defineComponent(function Demo(props: DemoProps) {
  // ── setup 区：顶层语句会被收集为实例字段 ──
  const count = createSignal(0);
  const double = createMemo(() => count() * 2);
  const label = 'count';        // 普通值 → 本地绑定
  onMount(() => console.log('mounted'));

  // ── 模板区：return 的 JSX 会被编译成模板 IR ──
  return <p>{label}: {double()}</p>;
});
```

对应关系：

| setup 区写法 | 编译结果 |
| --- | --- |
| `const count = createSignal(0)` | 实例字段 `this.count`（Signal） |
| `const double = createMemo(...)` | 实例字段 `this.double`（Computed） |
| `const label = 'count'` | 本地绑定（不会变成实例 Signal 字段） |
| `onMount()` / `onUpdated()` / `onCleanup()` | 生命周期槽（compile-only 标记） |
| `props` | 属性快照，每个 prop 的 getter 回读同名 Signal |

setup 区的语句不会在每次更新时重跑；模板区的表达式才会随依赖变化重新求值。

## 表达式规则

### 调用即订阅，引用即传值

```tsx
<p>{count()}</p>   // ✅ 读取值，并订阅 count
<p>{count}</p>     // ⚠️ 传的是 Signal 函数本身，不是它的值
<p>{double}</p>    // ⚠️ 同上
```

模板表达式里读到的 Signal / Store 路径由**编译器静态收集**，写进 `renderPlan` 的绑定表。因此：

- 表达式要能静态定位依赖，动态下标会截断到最后一个静态前缀；
- 不要在模板里把 Signal 解构或提前取出再使用；
- 依赖为空且可求值的表达式会被优化成静态值。

```ts
const state = createStore({ list: [{ name: 'a' }] });

state.list[0].name;     // 稳定路径，可精确订阅
state.list[index].name; // 动态下标 → 截断到 list
```

### 结构表达式 vs 结构节点

| 写法 | 编译结果 |
| --- | --- |
| `{cond ? <A /> : <B />}` | `ExpressionIR`：依赖变化时整体重算该位置 |
| `{cond && <A />}` | `ExpressionIR` |
| `{items().map((item) => <li>{item}</li>)}` | `ListIR`：走列表渲染路径 |
| `<When when={cond()}>` | `IfIR`：分支被保留，切换时不重建无关分支 |
| `<Each items={items()} key={...}>` | `ListIR`：带显式 key 与 `fallback` |

结论：三种写法都能编译，但**需要保留分支内部状态、需要稳定 key、需要 fallback 时，用增强组件**。

### 可静态分析的形状

`model`、`use`、事件对象必须是**对象字面量**，编译器需要在编译期读出 `target` / `handler` / `modifiers` 这些键：

```tsx
<input model={{ target: draft }} />        // ✅
<input model={binding} />                  // ❌ 不是对象字面量
<button onClick={{ handler: fn, modifiers: { stop: true } }} />  // ✅
```

对象字面量里暂不支持 spread 和计算属性名。

## 属性语法

### 普通属性与 property

```tsx
<input value={draft()} placeholder="type here" />
<button disabled={!ready()}>submit</button>
```

编译器会区分普通 attribute、DOM property（`value`、`checked`、`selected` 等）、事件与指令，并按目标选择写入方式。

### `class` / `className`

```tsx
<section
  className="card"
  class={[
    'panel',
    { active: isActive(), disabled: !ready() },
    tone() === 'danger' && 'panel--danger',
  ]}
/>
```

字符串、数组、对象三种形态可混用，并与静态 `class` 合并；`null` / `undefined` / `false` 被忽略。

### `style`

```tsx
<div
  style="color: red;"
  style={[{ width: `${width()}px` }, { '--accent': color() }]}
/>
```

支持字符串、对象、数组；camelCase 会转 kebab-case；`--*` 原样保留；数值不自动补单位。

### 原始 HTML

```tsx
import { html } from '@lania-v/runtime';

const content = html`<strong>${title()}</strong>`;

<article html={content} />;
```

`html` 只接受 `html\`...\`` 创建的品牌值，且不能与同一元素的子节点同时出现。

### 事件

```tsx
<button onClick={() => count.set(1)} />
<button onClick={{ handler: save, modifiers: { stop: true, prevent: true } }} />
<button onClick={{ handler: save, options: { capture: true, passive: true } }} />
```

| 修饰符 | 行为 |
| --- | --- |
| `stop` | `stopPropagation()` |
| `prevent` | `preventDefault()` |
| `self` | 仅当 `event.target === event.currentTarget` |
| `enter` | 仅键盘 `Enter` |
| `key:*` | 仅当 `event.key` 匹配 |
| `system:ctrl` / `shift` / `alt` / `meta` | 仅对应系统键按下 |

带 `options` 的监听不参与事件委托，以保留 `once` / `passive` / `capture` 语义。

### 双向绑定：`model`

```tsx
<input model={{ target: title }} />
<input model={{ target: count, modifiers: { number: true } }} />
<input type="checkbox" model={{ target: ready, prop: 'checked' }} />
<input model={{ source: { get: () => draft(), set: (v) => draft.set(v) } }} />
```

| 键 | 说明 |
| --- | --- |
| `target` | 直接绑定一个 Signal |
| `source` | 绑定自定义读写对，适合非 Signal 状态 |
| `prop` | `value`（默认）/ `checked` / `selected` |
| `modifiers` | `trim` / `number` / `lazy` |

### `ref`

```tsx
const inputRef = createRef<HTMLInputElement>();

<input ref={inputRef} />
<input ref={(element) => console.log(element)} />
```

组件上的 `ref` 收到的是 `createExpose()` 暴露的对象。

### 自定义指令

```tsx
<div use={{ watermark: { text: label() } }} />
```

指令需要用 `registerDirective('watermark', { mounted, updated, unmounted })` 注册。

## 组件标签

```tsx
import Card from './Card.lania.tsx';

<Card title="hello" count={count()} onSelect={(id) => select(id)}>
  <p>slot content</p>
</Card>;
```

| 写法 | 含义 |
| --- | --- |
| `title="hello"` | 作为 prop 写入组件实例的 Signal |
| `count={count()}` | 动态 prop |
| `onSelect={fn}` | 回调 prop（不是 `emit`） |
| `ref={ref}` | 接收 `createExpose()` 的公开面 |
| 子节点 | 成为宿主的 light DOM / childBindings，不自动进入 `props.children` |
| `{...obj}` | spread **仅支持组件标签**，原生元素上会报错 |
| `client:idle` 等 | Island 标记，不作为 prop 传递 |

原生元素上使用 spread 会被拒绝：

```tsx
<div {...rest} />        // ❌ spread: Spread attributes are only supported on component tags
<Card {...rest} />       // ✅
```

## 增强组件标签

增强组件由编译器识别，不是普通函数组件：

```tsx
<When when={visible()} fallback={<p>hidden</p>}>
  <p>visible</p>
</When>

<Each items={items()} key={(item) => item.id} fallback={<p>empty</p>}>
  {(item) => <li>{item.title}</li>}
</Each>

<Switch value={tab()}>
  <Case value="a"><PanelA /></Case>
  <Default><PanelB /></Default>
</Switch>
```

完整清单与每个组件的 props 见 [增强组件 API](/api/enhanced-components)。

## 两种语法模式

`tsxTemplateSyntaxMode` 决定编译器接受的属性写法。默认是 `jsx-standard`。

| 能力 | `jsx-standard`（默认） | `directive-extended` |
| --- | --- | --- |
| 双向绑定 | `model={ { target, modifiers } }` | `model={ { ... } }`、`model:value.trim={x}`、`model:checked={x}`、`bind:value={x}` |
| 类名开关 | `class={ { active: cond } }` | `class={ { ... } }`、`class:active={cond}` |
| 单条样式 | `style={ { width: ... } }` | `style={ { ... } }`、`style:width.px={n}` |
| 自定义指令 | `use={ { name: value } }` | `use={ { ... } }`、`use:name={value}` |
| 事件修饰符 | `onClick={ { handler, modifiers } }` | 同上，另有 `click.stop={fn}` |
| 组件事件 | `onClose={fn}` | 另有 `on:close={fn}` |
| 条件 | `<When>` | 另有 `if={cond}` |

两种模式**不能混用在同一套配置里**：`jsx-standard` 会主动拦截上面所有旧式指令写法，并给出明确的编译错误。新项目建议保持默认。

## 编译期硬约束

| 写法 | 结果 |
| --- | --- |
| 多个根节点 | 报错，需用 fragment 包裹 |
| 原生元素上 spread | 报错，spread 只允许组件标签 |
| `html` 与子节点并存 | 报错 |
| `model` / `use` / 事件对象不是对象字面量 | 报错 |
| 对象字面量里的 spread / 计算属性名 | 不支持 |
| `jsx-standard` 下使用 `model:` / `class:` / `use:` 等 | 报错 |
| 在未编译的普通 `.ts` 中调用 `onMount` 等 | compile-only 错误 |
| 包名或路径别名导入的 props 类型 | 不做类型展开 |
| `Pick<T, K>`、泛型实例化等需要类型检查的 props 类型 | 不支持 |

## 与 React JSX 的差异

| 维度 | React | lania-v |
| --- | --- | --- |
| JSX 产物 | VNode / Fiber | 真实 DOM 节点、组件元素或增强组件结果 |
| 组件函数 | 每次更新重新执行 | 只在挂载时执行一次，之后由 Updater 写 Slot |
| 条件 / 列表 | 任意表达式 | 推荐增强组件；三元与 `&&` 会被当作表达式节点 |
| 引用 Signal | — | 必须调用 `count()` 才订阅 |
| 属性写法 | 标准 JSX | 标准 JSX + `class` / `style` / `model` / `use` / `html` 对象协议 |
| `children` | `props.children` | 子节点是 light DOM；需要 `props.children` 请显式传 `children={...}` |
| `ref` | DOM 或 forwardRef | DOM 元素，或组件的 `createExpose()` 公开面 |
| 样式作用域 | 依赖 CSS 方案 | Shadow DOM + `Component.styles` |

## 速查卡

```tsx
// 文本
{count()}

// 属性 / property
id="x"  value={draft()}  disabled={!ready()}

// class
class="a"  class={{ a: cond }}  class={['a', { b: cond }]}

// style
style="color: red"  style={{ width: `${w()}px`, '--gap': gap() }}

// HTML
html={html`<b>${text()}</b>`}

// 事件
onClick={fn}  onClick={{ handler: fn, modifiers: { stop: true } }}

// 双向绑定
model={{ target: draft, modifiers: { trim: true } }}

// 引用
ref={inputRef}

// 指令
use={{ watermark: { text: 'x' } }}

// 条件 / 列表
<When when={cond()} fallback={<Empty />} />
<Each items={items()} key={(item) => item.id} />

// 组件
<Card title="hi" onSelect={fn}>{child}</Card>

// 组件暴露
createExpose(props, { focus: () => inputRef?.focus() });
```

## 下一步

- [模板与绑定](/guide/templates)：每个绑定的运行时语义。
- [条件与列表](/guide/control-flow)：增强组件的完整用法。
- [工程配置](/guide/configuration)：如何在项目里开启另一种语法模式。
