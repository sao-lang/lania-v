# 快速开始

这一章从空目录开始，创建一个最小可运行的 `lania-v` 应用。

## 环境要求

- Node.js 18+
- npm 9+（或 pnpm / yarn）
- 支持 Custom Elements、Shadow DOM 的现代浏览器

## 1. 安装依赖

```bash
npm install @lania-v/runtime @lania-v/vite-plugin
```

`@lania-v/vite-plugin` 会依赖并调用 `@lania-v/compiler-tsx` 与 `@lania-v/compiler-core`，无需单独安装编译器。

::: tip 在仓库内开发
本仓库使用 npm workspaces。克隆后执行 `npm install`，playground 会直接引用 `packages/*` 的源码，不需要发布包。
:::

## 2. 配置 Vite

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { laniaFcVitePlugin } from '@lania-v/vite-plugin';

export default defineConfig({
  plugins: [laniaFcVitePlugin()],
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: '@lania-v/runtime',
  },
});
```

插件只拦截 `.lania.tsx`。普通 `.tsx` 文件仍然由 esbuild/Vite 处理，所以 JSX 运行时也必须指向 `@lania-v/runtime`。

## 3. 配置 TypeScript 与 JSX 类型

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "jsxImportSource": "@lania-v/runtime",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts"]
}
```

再补一个 `src/jsx.d.ts`，让编辑器认识增强组件标签：

```ts
type RuntimeIntrinsicElementProps =
  import('@lania-v/runtime/jsx-runtime').LaniaIntrinsicElementProps<HTMLElement>;
type RuntimeNativeIntrinsicElements =
  import('@lania-v/runtime/jsx-runtime').LaniaNativeIntrinsicElements;
type RuntimeEnhancedIntrinsicElements =
  import('@lania-v/runtime/jsx-runtime').LaniaEnhancedIntrinsicElements;

declare namespace JSX {
  type Element = import('@lania-v/runtime/jsx-runtime').LaniaJsxElement;

  interface ElementChildrenAttribute {
    children: {};
  }

  interface IntrinsicAttributes {
    key?: unknown;
  }

  interface IntrinsicElements
    extends
      RuntimeNativeIntrinsicElements,
      RuntimeEnhancedIntrinsicElements,
      Record<string, RuntimeIntrinsicElementProps> {}
}
```

## 4. 写第一个组件

创建 `src/Counter.lania.tsx`：

```tsx
import { createSignal, defineComponent } from '@lania-v/runtime';

export default defineComponent(function Counter() {
  const count = createSignal(0);

  return (
    <section className="counter">
      <p>count: {count()}</p>
      <button onClick={() => count.set((value) => value + 1)}>+1</button>
    </section>
  );
});
```

这份源码会被编译成：

- 一个继承 `ReactiveElement` 的类；
- 实例字段 `count`（Signal）；
- 一个只订阅 `count` 的文本 Updater；
- 一个点击事件 Slot；
- 一份默认导出。

## 5. 挂载应用

```tsx
// src/main.tsx
import { createRoot, css } from '@lania-v/runtime';
import Counter from './Counter.lania.tsx';

const styles = css`
  :host {
    display: block;
    font-family: system-ui, sans-serif;
  }

  .counter {
    display: grid;
    gap: 12px;
    padding: 24px;
    border-radius: 16px;
    background: #0f172a;
    color: #e2e8f0;
  }

  button {
    justify-self: start;
    padding: 8px 14px;
    border-radius: 10px;
    border: 0;
    cursor: pointer;
  }
`;

Counter.styles = styles;

createRoot(document.querySelector('#app')!).render(<Counter />);
```

```html
<!-- index.html -->
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>lania-v counter</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

## 6. 启动

```bash
npx vite
```

如果使用本仓库的 playground：

```bash
npm run dev
```

## `createRoot()` 接受什么

`createRoot()` 是一个轻量挂载器，**只接受已经可渲染的值**：

```tsx
root.render(<Counter />); // JSX 结果
root.render(Counter({})); // 直接调用组件的结果
root.render(document.createElement('div'));
root.render('plain text');
root.render([<Counter />, <p>done</p>]);
```

它不做 Diff，也不会执行函数引用。下面这样会抛错：

```ts
root.render(Counter); // TypeError
```

需要真正挂载一个组件到容器时，也可以使用：

```ts
import { mountComponent } from '@lania-v/runtime';

mountComponent(document.querySelector('#app')!, Counter, {
  props: { title: 'hello' },
});
```

## 目录建议

```text
src/
├── App.lania.tsx
├── Counter.lania.tsx
├── components/
│   └── Panel.lania.tsx
├── shared/
│   └── format.ts
├── main.tsx
└── jsx.d.ts
```

- 组件放在 `.lania.tsx`；
- 可复用纯逻辑放在 `.ts`，由组件 `import`；
- 不要把需要在多个组件间复用的辅助函数留在 `.lania.tsx` 里——模块输出只会保留被编译产物引用到的声明。

## 下一步

- [编译模型](/guide/compilation-model)：理解源码如何变成 renderPlan。
- [响应式基础](/guide/reactivity)：Signal、Memo、Effect 与调度器。
- [模板与绑定](/guide/templates)：事件、`model`、`class`、`style`、`html`、`ref`。
