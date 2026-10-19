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

原生标签上的 `onXxx` 会映射为小写 DOM 事件（`onClick` → `click`）。组件标签上的 `onXxx` 会映射为组件事件（`onToggle` → `toggle`）。

### 对象写法与修饰符

```tsx
<button
  onClick={{
    handler: submit,
    modifiers: { stop: true, prevent: true },
  }}
/>
```

支持：

| 修饰符 | 行为 |
| --- | --- |
| `stop` | `event.stopPropagation()` |
| `prevent` | `event.preventDefault()` |
| `self` | 仅当 `event.target === event.currentTarget` 时执行 |
| `enter` | 仅键盘 Enter 时执行 |
| `key:escape` | 仅指定 `event.key` 时执行 |
| `system:ctrl` / `shift` / `alt` / `meta` | 仅对应系统键按下时执行 |

也可以在 `listener` 中声明原生监听选项：

```tsx
<button
  onClick={{
    handler: submit,
    listener: { once: true, capture: true, passive: false },
  }}
/>
```

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
// inputRef.current 指向真实 DOM
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
- 子节点会进入 `children`，供插槽读取；
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
