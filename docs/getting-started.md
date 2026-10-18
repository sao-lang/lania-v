# 从零创建示例

本文档给出 `lania-v` 当前最小可运行示例的创建方式。

## 1. 安装依赖

在仓库根目录：

```bash
npm install
```

## 2. 启动基础 playground

先验证运行时主路径：

```bash
npm run dev
```

默认会启动 `@lania-v/playground-todo`。

这个 playground 已覆盖：

- Todo 主流程
- 指令与绑定
- 本地状态
- TSX 组件组织示例
- 增强组件组合

## 3. React 集成与鼠标 Hook 示例

独立的 `playground/mouse-hook` workspace 演示 lania-v 组件在 React 页面中使用，
以及用 Signal 和生命周期 API 编写实时鼠标追踪 composable：

```bash
npm run dev --workspace @lania-v/playground-mouse-hook
```

在浏览器打开 `http://127.0.0.1:4177/`，移动或点击鼠标可观察坐标、目标元素、
按键与修饰键状态，并在控制台查看完整快照。

## 4. 创建函数组件示例

```tsx
const Counter = defineComponent((props: { title: string }) => {
  const count = createSignal(0);

  return (
    <button onClick={() => count.set((value) => value + 1)}>
      {props.title}: {count()}
    </button>
  );
});
```

然后用 `createRoot()` 渲染：

```ts
const root = createRoot(document.querySelector('#app')!);
root.render(Counter({ title: 'demo' }));
```

`createRoot()` 是轻量挂载器，接收的是“已经可渲染”的值。
可以传 `Counter({ title: 'demo' })` 或 `<Counter title="demo" />`，不要直接传 `Counter` 函数引用。

## 5. 启动编译器 playground

如果要查看 AST / IR / 依赖分析 / 代码生成：

```bash
npm run dev --workspace @lania-v/playground-compiler
```

## 6. 推荐路径

当前阶段建议：

- 主业务组件优先使用 `.lania.tsx`
- TSX 函数组件承担主业务逻辑和组合逻辑
- 复杂增强组件组合与高级 SSR 场景先参考现有测试再投入
