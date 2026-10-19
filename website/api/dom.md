# DOM 与绑定 API

这一页覆盖“把值写进 DOM”的所有公共工具：

- class / style / HTML 的归一化；
- `model` 双向绑定；
- ref；
- 自定义指令；
- Slot / SlotTable / Updater 等底层原语。

这些 API 中有不少由编译产物直接调用。业务代码通常只需要 `html`、`createRef`、`registerDirective`，但理解底层写入语义有助于排查更新问题。

## Class

### 归一化规则

```ts
type ClassValue =
  | string
  | number
  | null
  | undefined
  | false
  | Record<string, unknown>
  | readonly ClassValue[];
```

输入可以是：

```ts
'card active'
42
['card', { active: true, disabled: false }]
['card', ['nested', { selected: isSelected() }]]
```

统一输出：

```text
'card active'
'42'
'card active'
'card nested selected'
```

规则：

- 字符串按空白拆成 token；
- 数字转字符串；
- 对象中值为真的 key 加入；
- 数组递归展开；
- `null` / `undefined` / `false` 忽略；
- 空 token 会被过滤。

### `normalizeClassValue()`

```ts
normalizeClassValue(value: unknown): string
```

```ts
normalizeClassValue(['card', { active: true }, null]); // 'card active'
```

### `mergeClassValues()`

```ts
mergeClassValues(baseValue: unknown, dynamicValue: unknown): string
```

把静态 class 与动态 class 合并：

```ts
mergeClassValues('card', { active: true }); // 'card active'
```

### `writeClassAttribute()`

```ts
writeClassAttribute(element: Element, value: unknown, baseValue?: unknown): void
```

- 合并后为空：移除 `class` attribute；
- 否则：`setAttribute('class', normalized)`。

## Style

### 支持的形态

```ts
type StyleBindingValue =
  | string
  | null
  | undefined
  | false
  | CSSProperties
  | readonly StyleBindingValue[];
```

```tsx
style="color: red;"
style={{ width: `${width()}px`, '--accent': color() }}
style={['margin-top: 12px;', { padding: `${padding()}px` }]}
```

### 归一化规则

- 字符串按 `;` 拆声明；
- 对象 key 支持 camelCase，运行时转 kebab-case；
- `--*` 原样保留；
- 数值不会自动补单位；
- 后面的声明覆盖前面的同名声明；
- `null` / `undefined` / `false` / `''` 表示移除该声明。

```ts
normalizeStyleValue({
  backgroundColor: 'red',
  width: '100px',
  '--accent': '#7c3aed',
});
// 'background-color: red; width: 100px; --accent: #7c3aed;'
```

### `normalizeStyleValue()`

```ts
normalizeStyleValue(value: unknown): string
```

### `mergeStyleValues()`

```ts
mergeStyleValues(baseValue: unknown, dynamicValue: unknown): string
```

静态样式先放，动态样式后放，因此动态值优先级更高。

### `writeStyleAttribute()`

```ts
writeStyleAttribute(element: Element, value: unknown, baseValue?: unknown): void
```

- 合并后为空：移除 `style` attribute；
- 否则：`setAttribute('style', normalized)`。

### 单属性工具

```ts
normalizeStyleName(name: string): string
serializeStyleValue(value: StylePrimitive, unit?: string): string | null
applyStyleValue(target: HTMLElement, property: string, value: StylePrimitive, unit?: string): void
applyStyleObject(target: HTMLElement, next: StyleObject, previous?: StyleObject): StyleObject
```

`applyStyleObject()` 会对比前后对象，移除新对象中不存在的旧属性：

```ts
applyStyleObject(el, { color: 'red', width: '10px' });
applyStyleObject(el, { color: 'blue' }, { color: 'red', width: '10px' });
// width 被 removeProperty
```

## HTML

### `html`

```ts
html(strings: TemplateStringsArray, ...values: unknown[]): HtmlResult
```

```ts
import { html } from '@lania-v/runtime';

const content = html`<strong>${title()}</strong>`;

<article html={content} />;
```

`html` 只是把模板字符串拼成带品牌标记的对象：

```ts
interface HtmlResult {
  readonly kind: 'html-result';
  readonly htmlText: string;
  toString(): string;
}
```

### 为什么需要品牌标记

普通字符串可能是用户输入，直接写入 `innerHTML` 容易造成 XSS。运行时只接受 `HtmlResult`：

```ts
resolveHtmlBindingText('<b>unsafe</b>'); // warning + ''
resolveHtmlBindingText(html`<b>ok</b>`); // '<b>ok</b>'
```

### 安全边界

- `html` **不做消毒**；
- 插值使用 `String()` 拼接，不转义；
- 内容可信度由调用方负责；
- 不要拼接用户输入，除非你已经在别处做了严格消毒。

### `applyHtml()`

```ts
applyHtml(target: HTMLElement, value: unknown): void
```

内部执行：

```ts
target.innerHTML = resolveHtmlBindingText(value);
```

## Model

### 为什么需要 model

单向绑定需要手写：

```tsx
<input
  value={draft()}
  onInput={(event) => draft.set(event.target.value)}
/>
```

`model` 把“写入当前值”和“监听事件回写”合并成一个 Slot：

```tsx
<input model={{ target: draft }} />
```

### 两种绑定源

```ts
interface ModelTargetBinding<T> {
  target: (() => T) & { set(value: T): unknown };
  prop?: 'value' | 'checked' | 'selected';
  modifiers?: { trim?: boolean; number?: boolean; lazy?: boolean };
}

interface ModelSourceBinding<T> {
  source: {
    get: () => T;
    set: (value: T) => unknown;
  };
  prop?: 'value' | 'checked' | 'selected';
  modifiers?: { trim?: boolean; number?: boolean; lazy?: boolean };
}

type ModelBinding<T> = ModelTargetBinding<T> | ModelSourceBinding<T>;
```

#### `target`

直接绑定 Signal：

```tsx
<input model={{ target: draft }} />
<input type="number" model={{ target: count, modifiers: { number: true } }} />
<input type="checkbox" model={{ target: ready, prop: 'checked' }} />
```

#### `source`

绑定任意 getter / setter：

```tsx
<input
  model={{
    source: {
      get: () => state.query,
      set: (value) => state.set('query', value),
    },
  }}
/>
```

适合 Store 路径、非 Signal 状态或需要额外转换的场景。

### `prop`

| prop | 写入目标 | 事件 |
| --- | --- | --- |
| `value`（默认） | `element.value` | `input` |
| `checked` | `element.checked` | `change` |
| `selected` | `element.selected` | `input` |

`checked` 和带 `lazy` 的绑定使用 `change`，其余使用 `input`。

### 修饰符

| 修饰符 | 行为 |
| --- | --- |
| `trim` | 去掉字符串首尾空白 |
| `number` | `Number(value)` |
| `lazy` | 使用 `change` 事件而不是 `input` |

```tsx
<input model={{ target: draft, modifiers: { trim: true } }} />
<input model={{ target: age, modifiers: { number: true } }} />
<input model={{ target: name, modifiers: { lazy: true } }} />
```

### 初始值写入

`ModelBindingSlot.write()` 每次都会：

1. 读取 `target()` / `source.get()`；
2. 写入元素属性；
3. 确保事件监听存在。

因此组件重渲染时，输入框会与状态保持同步。

### 运行时工具

```ts
applyBoundValue(target, prop, value): void
normalizeModelValue(value: string, modifiers: readonly ModelModifier[]): string | number
createModelEventHandler(target, modifiers?, prop?): (event: Event) => void
readModelModifiers(binding?): ModelModifier[]
```

`createModelEventHandler()` 在事件发生时：

1. 从 `event.target[prop]` 读取值；
2. 应用 `trim` / `number`；
3. 调用 `target.set(...)`。

## Ref

### `createRef()`

```ts
interface RefObject<T> {
  current: T | null;
}

createRef<T>(): RefObject<T>
```

```tsx
const inputRef = createRef<HTMLInputElement>();

<input ref={inputRef} />;
```

挂载后 `inputRef.current` 指向真实 DOM；卸载后为 `null`。

### 函数 ref

```ts
type RefBinding<T> = RefObject<T> | ((value: T | null) => void);
```

```tsx
<input ref={(element) => console.log(element)} />
```

### `setRef()`

```ts
setRef<T>(ref: RefBinding<T> | null | undefined, value: T | null): void
```

立即写入。

### `queueRefWrite()`

```ts
queueRefWrite<T>(ref: RefBinding<T> | null | undefined, value: T | null): void
```

把写入合并到微任务：

- 同一个 ref 多次写入只保留最后一次；
- 适合 DOM patch 过程中暂存 ref；
- 节点稳定后再统一刷新。

## 自定义指令

### `registerDirective()`

```ts
interface DirectiveDef<T, TElement extends HTMLElement> {
  mounted?(el: TElement, value: T): void;
  updated?(el: TElement, value: T, oldValue: T | undefined): void;
  unmounted?(el: TElement): void;
}

registerDirective<T = unknown>(name: string, directive: DirectiveDef<T>): void
```

```ts
registerDirective<{ text: string }>('watermark', {
  mounted(el, value) {
    el.dataset.watermark = value.text;
  },
  updated(el, value, oldValue) {
    if (oldValue?.text === value.text) return;
    el.dataset.watermark = value.text;
  },
  unmounted(el) {
    delete el.dataset.watermark;
  },
});
```

### 使用

```tsx
<div use={{ watermark: { text: label() } }} />
```

`use` 的对象 key 是注册名，value 是传给指令的值。

### 内联指令定义

运行时也允许直接把 `DirectiveDef` 作为值：

```tsx
<div
  use={{
    highlight: {
      mounted(el) {
        el.style.background = 'yellow';
      },
    },
  }}
/>
```

判断逻辑：值上存在 `mounted` / `updated` / `unmounted` 之一即视为 `DirectiveDef`。

### 生命周期

| 阶段 | 触发 |
| --- | --- |
| `mounted` | 第一次 `write()` |
| `updated` | 同一个 Slot 后续 `write()` |
| `unmounted` | `destroy()` 或绑定被移除 |

绑定从有值变为 `null` 时：

- 内部 `DirectiveSlot.destroy()`；
- 清空当前定义；
- 不保留旧副作用。

### `resolveDirective()` / `clearDirectiveRegistry()`

```ts
resolveDirective<T>(name: string): DirectiveDef<T> | undefined
clearDirectiveRegistry(): void
```

`clearDirectiveRegistry()` 主要给测试使用。

### `DirectiveSlot`

```ts
class DirectiveSlot<TValue, TElement extends HTMLElement> {
  constructor(node: TElement, def: DirectiveDef<TValue, TElement>, index: number);
  write(value: TValue): void;
  destroy(): void;
}
```

内部维护 `initialized` 与 `previousValue`，负责把首次写入映射到 `mounted`。

## 动态绑定 Slot

### 读取编译期绑定

```ts
readDynamicEvents(props: Record<string, unknown>): DynamicEventBinding[]
readDynamicDirectives(props: Record<string, unknown>): DynamicDirectiveBinding[]
```

编译产物把这些信息放在私有字段：

- `props.__lania_events`
- `props.__lania_directives`

### 创建 Slot

```ts
createDirectiveSlotForBinding(element, binding, index): Slot<unknown>
```

按 `binding.kind` 分发：

| kind | Slot |
| --- | --- |
| `bind` | `DirectiveBindingSlot` |
| `model` | `ModelBindingSlot` |
| `html` / `unknown` | `DirectiveBindingSlot` |
| `class` | `ClassSlot` |
| `style` | `StyleSlot` |
| `use` | `UseDirectiveSlot` |
| `ref` | `RefSlot` |

### 内置绑定 Slot

| 类 | 说明 |
| --- | --- |
| `UseDirectiveSlot` | `use` 指令，支持 KeepAlive 保活 |
| `ModelBindingSlot` | `model` 双向绑定 |
| `DirectiveBindingSlot` | 普通属性 / HTML 写入 |
| `RefSlot` | ref 写入 |

## Slot 基础

::: tip 命名冲突
根入口同时导出增强组件 `Slot` 与 DOM Slot 类型，因此 DOM Slot 类型以 `DomSlot` 名称导出：

```ts
import type { DomSlot, SlotType, SlotFrequency } from '@lania-v/runtime';
// 或从子入口导入
import type { Slot } from '@lania-v/runtime/dom';
```

:::

```ts
type SlotType =
  | 'text'
  | 'attribute'
  | 'style'
  | 'class'
  | 'property'
  | 'event'
  | 'if'
  | 'for'
  | 'component'
  | 'dynamic'
  | 'boundary'
  | 'teleport'
  | 'keepalive'
  | 'directive'
  | 'ref'
  | 'style-map';

type SlotFrequency = 'high' | 'normal' | 'low';

interface Slot<T = unknown> {
  type: SlotType;
  node: EventTarget | Node | Element | HTMLElement;
  index: number;
  frequency: SlotFrequency;
  write(value: T): void;
  destroy(): void;
}
```

### 写入语义

| Slot | 写入行为 |
| --- | --- |
| `TextSlot` | 写 `Text.data`；节点 / 数组会插入真实节点 |
| `AttrSlot` | 写 attribute；class / style / 部分 property 有特化 |
| `StyleSlot` | 写单条 style 声明 |
| `StyleObjectSlot` | 合并 style 对象并移除旧属性 |
| `ClassSlot` | 开关单个 class |
| `PropSlot` | 写 DOM property |
| `EventSlot` | 安装 / 替换事件监听 |
| `IfSlot` | 在 truthy / falsy 分支间切换 |
| `ForSlot` | 协调列表节点 |
| `ComponentSlot` | 写组件 props |
| `DynamicSlot` | 动态组件 / 标签 |
| `BoundarySlot` | Suspense / ErrorBoundary / LazyLoad |
| `TeleportSlot` | 挂载到外部容器 |
| `KeepAliveSlot` | 缓存子树 |
| `UseDirectiveSlot` | 自定义指令 |
| `ModelBindingSlot` | 双向绑定 |
| `DirectiveBindingSlot` | 普通属性 / HTML |
| `RefSlot` | ref |

### `TextSlot` 的细节

```ts
write(value) {
  if (isNodeLike(value)) {
    // 插入节点，清空文本
  } else {
    // 写文本
  }
}
```

它在内部记录 `previous`，相同文本不会重复写 DOM。

### DOM 辅助

```ts
cloneFactoryNodes(...)
appendNodesBeforeAnchor(parent, anchor, nodes)
insertNodeBeforeSafe(parent, node, beforeNode)
collectKeyedBlockElements(block)
collectKeyedBlockNodes(block)
removeNodes(nodes)
reconcileNodesBeforeAnchor(...)
normalizeDynamicResult(value): Node[]
setDynamicAttribute(element, name, value)
appendDynamicChildren(element, children)
writeComponentProp(target, name, value)
```

`reconcileNodesBeforeAnchor()` 是列表协调的核心工具：它按顺序复用、插入、移除节点，避免整段重建。

## SlotTable

### 为什么需要脏位

组件一次更新可能涉及很多 Slot，但只有少数发生变化。`SlotTable` 使用 `bigint` 记录哪些 Slot 为脏：

```ts
getSlotBit(index: number): bigint // 1n << BigInt(index)
```

```ts
class SlotTable {
  register<TSlot extends Slot>(slot: TSlot): TSlot;
  get<TSlot extends Slot = Slot>(index: number): TSlot | undefined;
  markDirty(index: number): void;
  markDirtySlots(indices: Iterable<number>): void;
  isDirty(index: number): boolean;
  clearDirty(index?: number): void;
  getDirtySlots(): Slot[];
  getSlotsByFrequency(frequency: SlotFrequency): Slot[];
  destroyAll(): void;
  get size(): number;
  get dirty(): bigint;
}
```

用途：

- Updater 执行前快速判断是否还有脏 Slot；
- 组件 flush 时只补跑活跃分支；
- `destroyAll()` 按索引顺序销毁，保证 teardown 稳定。

## Slot 池

```ts
acquireSlotNodeBuffer(): Node[]
releaseSlotNodeBuffer(buffer: Node[]): void
getSlotPoolStats(): { availableNodeBuffers: number }
clearSlotPool(): void
```

动态节点协调会反复创建临时数组。Slot 池复用这些数组，减少 GC 压力。

## Updater

### `Updater` 协议

```ts
interface Updater {
  debugId: number;
  deps: Set<Signal<any>>;
  slots: Slot[];
  priority: JobPriority;
  dirty: boolean;
  run(): void;
  attach(): void;
  detach(): void;
}
```

### 内置实现

| 类 | 用途 |
| --- | --- |
| `SimpleUpdater<T>` | 一个表达式写一个 Slot |
| `MultiSlotUpdater<T>` | 一个表达式写多个 Slot |
| `ConditionUpdater<T>` | 条件分支 |
| `EffectUpdater` | 语句块副作用 |

### 执行流程

```ts
run() {
  // 1. 首轮：trackSignals(compute)，补齐依赖
  // 2. 后续：直接 compute()
  // 3. 与上次结果相等：跳过 commit
  // 4. 否则：commit -> writeSlot
}
```

### 首轮依赖发现

编译器通常已经注入依赖，但 composable 返回的 Signal、动态路径等可能无法静态分析。`BaseUpdater` 会在第一次运行时补一次：

```ts
const tracked = trackSignals(() => this.compute());
this.deps = tracked.deps;
```

只做一次，避免常态更新承担追踪成本。

### `attach()` / `detach()`

```ts
for (const signal of this.deps) {
  signal.updaters.add(this.job);
}
```

`job` 会把 Updater 标记为 dirty 并执行。`detach()` 反向移除。

### 调试事件

开发态会发出：

- `updater-run`：包含 `updaterId`、依赖 ID、Slot 列表；
- `slot-write`：包含 Slot 类型、索引、目标节点。

配合 `installDevtoolsOverlay()` 可以高亮被写入的 DOM。

## 示例：自定义指令

```ts
import { registerDirective } from '@lania-v/runtime';

registerDirective<{ text: string; tone: 'violet' | 'emerald' }>('watermark', {
  mounted(el, value) {
    el.dataset.watermark = value.text;
    el.style.setProperty('--watermark-tone', value.tone);
  },
  updated(el, value, oldValue) {
    if (oldValue?.text !== value.text) {
      el.dataset.watermark = value.text;
    }
    if (oldValue?.tone !== value.tone) {
      el.style.setProperty('--watermark-tone', value.tone);
    }
  },
  unmounted(el) {
    delete el.dataset.watermark;
    el.style.removeProperty('--watermark-tone');
  },
});
```

```tsx
<div use={{ watermark: { text: label(), tone: tone() } }} />
```

## 示例：Store 双向绑定

```tsx
<input
  model={{
    source: {
      get: () => state.query,
      set: (value) => state.set('query', value),
    },
    modifiers: { trim: true },
  }}
/>
```

## 常见问题

### 为什么 style 数值没有生效？

数值不会自动补 `px`：

```tsx
style={{ width: width() }}        // width: 300; 无效
style={{ width: `${width()}px` }} // 正确
```

### 为什么 html 绑定没有输出？

只接受 `html\`...\`` 创建的值。普通字符串会告警并返回空字符串。

### 为什么 model 没有回写？

检查：

- `target` 是否有 `set`；
- `source` 是否同时提供 `get` / `set`；
- 事件是否被 `stop` / `prevent` 拦截；
- 是否使用了 `lazy`，导致等待 `change`。
