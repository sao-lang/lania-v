# 模板与绑定

`.lania.tsx` 使用 TSX 作为模板语法。与 React 不同，JSX 在这里不会创建 Virtual DOM，而是直接生成 DOM 节点、组件元素或增强组件结果。

## JSX 返回什么

```ts
type LaniaJsxElement =
  | Node
  | string
  | number
  | boolean
  | null
  | undefined
  | (() => LaniaJsxElement)
  | readonly LaniaJsxElement[];
```

因此组件的返回值就是“可渲染值”，没有额外的 VNode 包装。

## 文本与子节点

```tsx
<p>Hello</p>
<p>{name()}</p>
<p>Hello, {name()}!</p>
```

插值会被转义为文本。要写入原始 HTML，必须显式使用 `html`。

`null`、`undefined`、`false` 都渲染为空。

## 属性与 property

普通属性直接写在 JSX 上：

```tsx
<input value={draft()} placeholder="type here" />
<button disabled={!ready()}>submit</button>
```

编译器会区分：

- 普通 attribute；
- DOM property（`value`、`checked`、`selected` 等）；
- 事件；
- 指令。

## `class` / `className`

`className` 支持字符串、对象、数组，并会与静态 `class` 合并：

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

归一化规则：

- 字符串按空白拆成 token；
- 对象中值为真的 key 会被加入；
- 数组递归展开；
- `null` / `undefined` / `false` 被忽略；
- 静态 `class` 与动态值合并后统一写入 `class` attribute。

## `style`

`style` 支持字符串、对象、数组，并与静态 `style` 合并：

```tsx
<div
  style="color: red;"
  style={[
    'margin-top: 12px;',
    {
      width: `${width()}px`,
      backgroundColor: tone() === 'violet' ? '#7c3aed' : '#059669',
      '--accent': color(),
    },
  ]}
/>
```

规则：

- 对象 key 支持 camelCase，运行时转成 kebab-case；
- `--*` 开头的 CSS 变量原样保留；
- 数值**不会自动补单位**，需要自己写 `px`、`%`、`rem` 等；
- 后面的声明覆盖前面的同名声明；
- 值为 `null` / `undefined` / `false` / `''` 会移除该声明。

## 原始 HTML

```tsx
import { html } from '@lania-v/runtime';

const content = html`<strong>${title()}</strong>`;

<article html={content} />;
```

`html` 返回带品牌标记的 `HtmlResult`。运行时只接受由 `html\`...\`` 创建的值：

```tsx
<div html="<b>unsafe</b>" />; // 不会写入，开发态告警
```

注意：

- `html` 不会做消毒，内容可信度由调用方负责；
- `html` 不能和同一元素的静态 / 动态子节点同时出现，编译器会直接报错；
- 插值使用 `String()` 拼接，不转义。

## 事件

### 基本写法

```tsx
<button onClick={submit}>submit</button>
<input onInput={(event) => draft.set(event.target.value)} />
```

事件名解析规则：

| 写法 | 目标 | 适用模式 |
| --- | --- | --- |
| `onClick` | DOM `click` | 全部模式 |
| `onKeyDown` | DOM `keydown` | 全部模式 |
| `onToggle`（组件标签上） | 组件事件 `toggle` | 全部模式 |
| `on:close`（组件标签上） | 组件事件 `close` | 仅 `directive-extended` |
| `onClick.stop` | DOM `click` + `stop` 修饰符 | 全部模式 |
| `click.stop` | 小写事件名 + 修饰符 | 仅 `directive-extended` |

::: warning 组件标签上的 `onXxx` 是事件，不是普通 prop
编译器会把组件标签上的 `onXxx` 一律当作组件事件（子组件通过 `emit()` 派发）。
需要父传回调时，请改用非 `on` 前缀的 prop 名（如 `submitHandler`），
或用 `props` 显式传入。
:::

标准 JSX 模式（默认）下使用对象写法表达修饰符：

```tsx
<button
  onClick={{
    handler: submit,
    modifiers: { stop: true, prevent: true },
  }}
/>
```

扩展语法模式（`directive-extended`）可以直接把修饰符写在事件名上：

```tsx
<button onClick.stop.prevent={submit} />
<input onKeydown.enter={submit} />
```

### 对象写法与修饰符

```tsx
<button
  onClick={{
    handler: submit,
    modifiers: { stop: true, prevent: true },
  }}
/>
```

| 修饰符 | 行为 |
| --- | --- |
| `stop` | `event.stopPropagation()` |
| `prevent` | `event.preventDefault()` |
| `prevent.self` | 仅当 `event.target === event.currentTarget` 时 `preventDefault()` |
| `prevent.immediate` | `preventDefault()` + `stopImmediatePropagation()` |
| `self` | 仅当 `event.target === event.currentTarget` 时执行 |
| `enter` | 仅键盘 `Enter` 时执行，只对键盘事件有效 |
| `immediate` | `event.stopImmediatePropagation()`，同一节点后续监听不再执行 |
| `passive` | 提示性标记；真正生效需写入 `listener: { passive: true }` |
| `left` / `middle` / `right` | 仅对应鼠标键触发时执行 |
| `key:escape` | 仅当 `event.key` 匹配时执行 |
| `system:ctrl` / `shift` / `alt` / `meta` | 仅对应系统键按下时执行 |
| `debounce` / `throttle` | 把处理器包进定时器，见下方“提示性修饰符” |

补充规则：

- `enter`、`key:*`、`system:*` 只能用于键盘事件（`keydown` / `keyup` / `keypress`），其他元素上会报编译错误；
- 键盘事件上写任意普通词等价于 `key:<词>`，例如 `keydown.escape` → `key:escape`；但 `once`、`immediate`、`passive`、`left`/`middle`/`right` 等保留词保持原义；
- 多个修饰符按声明顺序执行，任一过滤条件不满足就直接短路，后面的修饰符与 handler 都不会执行；
- `once` / `capture` / `passive` 属于原生监听选项，写在 `listener` 里（后缀写法 `onClick.once` 会被自动降级成 listener 选项）。

### 提示性修饰符

`debounce` / `throttle` 需要额外监听，编译器会把它们降级成运行时的 `withEventHint()`，也可以自己包：

```tsx
<input onInput.debounce={search} />                 {/* directive-extended */}
<input onInput={{ handler: search, modifiers: { debounce: true } }} />

// 等价的手写形式
import { withEventHint } from '@lania-v/runtime';

<input onInput={withEventHint(search, 'debounce', [], { debounceMs: 200 })} />
```

后两种写法在编译期都会拆成“处理器 + 提示”，不会出现双层包装。

### 原生监听选项

```tsx
<button
  onClick={{
    handler: submit,
    listener: { once: true, capture: true, passive: false },
  }}
/>
```

`listener` 直接透传给 `addEventListener` 的第三参；一旦声明了 `listener`，该监听不会走事件委托。

### 组件事件

组件标签上的 `onXxx` / `on:xxx` 是**组件事件**，由子组件通过 `emit()` 派发：

```tsx
<child-card onToggle={handleToggle} />
<child-card on:close={handleClose} /> {/* directive-extended */}
```

组件事件只支持 `listener` 选项，不接受 DOM 修饰符：

```tsx
// ✅ 允许
<child-card onToggle={{ handler: handleToggle, listener: { once: true } }} />

// ❌ 编译报错：组件事件不支持修饰符
<child-card onToggle={{ handler: handleToggle, modifiers: { stop: true } }} />
```

需要“父传回调”而不是事件时，请使用非 `on` 前缀的 prop 名（如 `submitHandler`），
或用 `props` 显式传入；`onXxx` 在组件标签上一定会被当作事件处理。

### 事件委托

运行时会为白名单事件（`click`、`input`、`change`、`keydown`、`keyup`、`keypress`、`submit`、`focus`、`blur`、`pointerdown`、`pointerup`）启用委托：

```ts
import { enableEventDelegation } from '@lania-v/runtime';

enableEventDelegation(document.querySelector('#app')!);
```

启用后，同一 root 上同一事件只挂一条原生监听，再按 `composedPath()` 分发到具体节点。带 `options` 的监听不会走委托，以免丢失 `once` / `passive` / `capture` 语义。

## 双向绑定：`model`

主路径写法是对象形式：

```tsx
<input model={{ target: draft, modifiers: { trim: true } }} />
```

支持的目标：

```tsx
<input model={{ target: title }} />                       // value（默认）
<input type="number" model={{ target: count, modifiers: { number: true } }} />
<input type="checkbox" model={{ target: ready, prop: 'checked' }} />
<select model={{ target: selected, prop: 'selected' }} />
```

完整类型：

```ts
interface ModelTargetBinding<T> {
  target: Signal<T>;
  prop?: 'value' | 'checked' | 'selected';
  modifiers?: {
    trim?: boolean;
    number?: boolean;
    lazy?: boolean;
  };
}

interface ModelSourceBinding<T> {
  source: {
    get: () => T;
    set: (value: T) => unknown;
  };
  prop?: 'value' | 'checked' | 'selected';
  modifiers?: { trim?: boolean; number?: boolean; lazy?: boolean };
}
```

修饰符：

- `trim`：去掉首尾空白；
- `number`：转换成 `Number`；
- `lazy`：保留给“变更时再同步”的策略。

没有 `model` 参数时等价于 `model:value`。

## `ref`

```tsx
import { createRef } from '@lania-v/runtime';

const inputRef = createRef<HTMLInputElement>();

<input ref={inputRef} />;
// 挂载后直接访问即可，mount 之前为 null
inputRef?.focus();
```

也支持函数 ref：

```tsx
<input ref={(element) => console.log(element)} />
```

多次写入会在一个微任务内合并：

```ts
import { queueRefWrite, setRef } from '@lania-v/runtime';

queueRefWrite(inputRef, element); // 合并到微任务
setRef(inputRef, element);        // 立即写入
```

组件 ref 会拿到 `createExpose()` 暴露的对象，详见 [组件](/guide/components#createexpose)。

## 自定义指令

注册指令：

```ts
// src/watermark-directive.ts
import { registerDirective } from '@lania-v/runtime';

registerDirective('watermark', {
  mounted(el, value) {
    el.dataset.watermark = value.text;
  },
  updated(el, value, oldValue) {
    el.dataset.watermark = value.text;
  },
  unmounted(el) {
    delete el.dataset.watermark;
  },
});
```

在元素上使用：

```tsx
<div
  use={{
    watermark: {
      text: label(),
      tone: tone(),
    },
  }}
/>
```

指令生命周期：

| 阶段 | 触发时机 |
| --- | --- |
| `mounted` | 首次写入 |
| `updated` | 同一个 Slot 后续写入 |
| `unmounted` | 节点销毁或 Slot 释放 |

`directive-extended` 模式还兼容 `use:watermark={...}`。

## 条件与列表

推荐使用增强组件：

```tsx
<When when={visible()} fallback={<p>hidden</p>}>
  <p>visible</p>
</When>

<Each items={items()} key={(item) => item.id} fallback={<p>empty</p>}>
  {(item) => <li>{item.title}</li>}
</Each>
```

详见 [条件与列表](/guide/control-flow)。

## 组件标签

```tsx
import Card from './Card.lania.tsx';

<Card title="hello" count={count()} onSelect={(id) => select(id)}>
  <p>slot content</p>
</Card>;
```

- 普通 props 会写入组件实例的对应 Signal；
- `onXxx` 会作为回调 prop 传入；
- 子节点会成为宿主的 light DOM / childBindings，不会自动写入 `props.children`；
  需要 `bindSlots()` 时请显式传 `children={...}`（见 [插槽](/guide/slots)）；
- `ref={...}` 会收到 `createExpose()` 的返回值；
- `client:idle` 等 island 标记不会作为 prop 传递。

## 编译约束

以下写法会被编译器拒绝或需要改写：

| 写法 | 说明 |
| --- | --- |
| `html` 与 children 同时出现 | 冲突 |
| `use` / `model` / 对象事件不是对象字面量 | 需要可静态分析的形状 |
| 对象字面量中的 spread / 计算属性名 | 暂不支持 |
| 在 `defineComponent` 内直接调用 `onMount` 等生命周期 | 必须是编译链处理 |
| 非相对路径导入的 props 类型 | 当前不支持类型展开 |

## 下一步

- [组件](/guide/components)：`defineComponent`、props、slots、context、表单。
- [增强组件 API](/api/enhanced-components)：所有增强组件的 props。
