---
layout: home

hero:
  name: lania-v
  text: 编译优先的细粒度框架
  tagline: 用 .lania.tsx 描述组件，把依赖分析交给编译器，把 DOM 更新交给 Signal 与 Slot。
  image:
    src: /logo.svg
    alt: lania-v
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: 核心概念
      link: /guide/compilation-model
    - theme: alt
      text: API 参考
      link: /api/reactivity

features:
  - title: 编译优先，不做整树 Diff
    details: 编译器把 TSX 拆成 Component IR、renderPlan、Slot 与 Updater。运行时只执行已经规划好的精确更新。
  - title: Signal 驱动的细粒度更新
    details: createSignal / createMemo / createEffect 组成依赖图，变更按优先级进入 Scheduler，只写入真正变化的 Slot。
  - title: 原生 Web Components
    details: 每个组件最终是一个 Custom Element，可单独分发、在任意页面挂载，也可以与 React、Vue 等框架共存。
  - title: 声明式增强组件
    details: When、Each、Switch、Teleport、KeepAlive、Transition、Suspense、ErrorBoundary 等能力由编译器识别并下沉到运行时。
  - title: SSR / DSD / Islands
    details: 输出 Declarative Shadow DOM，并提供 eager、idle、visible、interaction 四档部分水合策略。
  - title: TypeScript 与开发体验
    details: JSX 类型、prop options、编译诊断、HMR、devtools overlay 与 __lania 检查器全部开箱可用。
---

## 一条直线式的更新链路

```text
TSX / FC
  → Component IR
  → renderPlan
  → Updater
  → Slot
  → DOM
```

运行时没有 Virtual DOM，也不会在每次状态变化后比较整棵树。编译器已经知道：

- 哪个表达式依赖哪个 Signal；
- 这个表达式最终写进哪个 Slot；
- 这段结构在哪种条件下需要重建。

所以一次更新可以短到只有几步：

```ts
const count = createSignal(0);

// 编译后的 updater 只订阅 count，只写入绑定 count 的文本 Slot
count.set((value) => value + 1);
```

## 从一个组件开始

```tsx
import { createSignal, defineComponent } from '@lania-v/runtime';

export default defineComponent(function Counter() {
  const count = createSignal(0);

  return (
    <button onClick={() => count.set((value) => value + 1)}>
      count: {count()}
    </button>
  );
});
```

`Counter` 会被编译成一个继承 `ReactiveElement` 的自定义元素类：

- `count` 成为实例上的 Signal 字段；
- `onClick` 被编译成事件绑定；
- `{count()}` 被编译成只订阅 `count` 的文本 Slot；
- 点击按钮时，只有这个文本节点被改写。

继续阅读 [快速开始](/guide/getting-started)，或先了解 [为什么 lania-v 选择编译优先](/guide/introduction)。
