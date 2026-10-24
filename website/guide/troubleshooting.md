# 常见问题与排错

这一页按「先定位在哪一层，再对症下药」组织。绝大多数问题落在三层之一：**编译期**、**运行时**、**SSR / 水合**。

## 先定位

| 现象                              | 最可能的层  | 先看                              |
| --------------------------------- | ----------- | --------------------------------- |
| Vite overlay 报错、页面打不开     | 编译期      | [编译期报错](#编译期报错)         |
| 页面能开，但点了没反应 / 数字不变 | 运行时      | [视图不更新](#视图不更新)         |
| 组件显示了但标签没被升级          | 注册 / 加载 | [组件没被注册](#组件没被注册)     |
| 首屏有内容，交互后异常或重复      | SSR / 水合  | [ssr-与水合问题](#ssr-与水合问题) |

打开控制台，先确认有没有 `[lania-v]` 开头的日志。开启 `debug: true` 后，编译期还会输出 `[lania-v] compile: <Component>` 分组。

## 编译期报错

### `.lania.tsx` 没有被编译

按顺序检查：

1. 文件名是否以 `.lania.tsx` 结尾（不是 `.tsx`、不是 `.lania.ts`）；
2. `tsxInclude` 是否匹配，`tsxExclude` 是否把它排除了；
3. 插件是否真的注册了（`plugins: [laniaFcVitePlugin()]`）；
4. 插件是否被别的 TS/JSX 插件抢先生效（本插件是 `enforce: 'pre'`，但自定义插件可能也是 pre）。

判断方法：在 `debug: true` 下，编译成功的组件会打印 `[lania-v] compile: X`。没有这行就说明插件没命中。

### `component must return a JSX element or fragment`

组件返回了多个根节点。用 fragment 包裹：

```tsx
// ❌
return (<p>a</p><p>b</p>);

// ✅
return (<><p>a</p><p>b</p></>);
```

### `Legacy TSX directive syntax "..." is not supported in standard TSX mode`

命中了已移除的旧式指令写法，按错误提示改成标准 JSX：

```tsx
// ❌ model:value={draft}
<input model={{ target: draft }} />

// ❌ class:active={isActive()}
<div class={{ active: isActive() }} />
```

完整对照见 [语法参考 · 不支持的指令写法](/guide/syntax#不支持的指令写法)。

### `spread: Spread attributes are only supported on component tags`

原生元素上不能展开对象：

```tsx
<div {...rest} />   // ❌
<Card {...rest} />  // ✅
```

原生元素请逐个写属性。

### `` `modifiers` must be an object literal ``

事件、`model`、`use` 的对象必须是**字面量**，编译器要在编译期读出键名：

```tsx
<button onClick={{ handler: save, modifiers: { stop: true } }} />  // ✅
<button onClick={{ handler: save, modifiers: ['stop'] }} />        // ❌
```

### `html` 与子节点冲突

```tsx
<article html={content}>text</article>  // ❌
<article html={content} />              // ✅
```

### props 类型不生效 / 解构报错

编译器只做**语法级**的类型展开，支持：

- 内联对象类型；
- 同文件 `type` / `interface`（含 `extends`）；
- 交叉类型；
- 相对路径导入的具名类型。

不支持包名 / 路径别名的类型、`Pick<T, K>`、泛型实例化。遇到时把 props 类型就地写清楚：

```tsx
function Card(props: { title: string; count: number }) {
  /* ... */
}
```

### 读不懂的报错位置

Vite overlay 会给出文件名、行、列与源码帧。如果行列看起来偏移，检查：

- 是否在文件顶部有复杂的前置注释或装饰器；
- 是否同时启用了别的 TS 插件改写了源码；
- sourcemap 是否被上游插件覆盖。

## 视图不更新

按可能性从高到低排查。

### 1. 没有调用 Signal

```tsx
<p>{count()}</p>   // ✅ 订阅
<p>{count}</p>     // ❌ 传的是函数本身，不是值
```

模板里必须**调用**才读取依赖。

### 2. 读在响应式作用域之外

```tsx
const value = count(); // ❌ 只读一次，之后不再更新
return <p>{value}</p>;

const value = createMemo(() => count()); // ✅
return <p>{value()}</p>;
```

### 3. 解构了 Signal

```ts
const { value } = someSignal; // ❌ Signal 不是普通对象
```

Signal 是一个函数，直接调用即可，不要解构内部结构。

### 4. 改的是副本

```ts
const [first] = items(); // ❌ 拿到的是快照
items().push(item); // ❌ 修改快照不会触发更新
items.set([...items(), item]); // ✅
```

Atom 场景不能用「改副本」或直接 `push`（atom 视图是只读的，属性赋值与数组变更方法都会报错），要走路径写入或函数式更新：

```ts
state.set('list', (list) => [...list, item]); // ✅ 路径 + updater
state.set((prev) => ({ ...prev, list: [...prev.list, item] })); // ✅ 整体更新
```

### 5. 存在两份运行时

症状是「`set` 之后没有任何 Updater 执行」。常见来源：

- 同时通过 alias 与 `node_modules` 解析到 `src` 和 `dist` 两份 `@lania-v/runtime`；
- 库把运行时打进了自己的产物，宿主又引入了一份。

检查方法：在控制台比较两个组件的 `Signal` 构造来源，或搜索产物里是否出现两份 `createSignal` 实现。保证全链路只有一个 `@lania-v/runtime` 实例。

### 6. 组件 props 没传进去

```tsx
<Card title="hello" />          // 字符串属性 → prop
<Card title={title()} />        // 动态 prop
```

父组件用 attribute 传对象时，属性会以字符串形式到达。对象请用动态 prop（`{...}`）或 `ref` + `createExpose()`。

### 7. 事件没触发

| 写法                                                     | 说明               |
| -------------------------------------------------------- | ------------------ |
| `onClick={fn}`                                           | 原生 DOM 事件      |
| `onClick={ { handler: fn, modifiers: { stop: true } } }` | 需要修饰符时的写法 |
| `onSelect={fn}`（组件标签上）                            | 回调 prop          |
| 组件内部 `this.emit('select')`                           | Custom Event       |

组件上写 `onSelect` 只是传入回调；需要 DOM 事件语义时，在子组件里 `emit()`，父组件监听 `onSelect`。

## 组件没被注册

### 导入方式不对

默认导出是组件构造器：

```tsx
import Counter from './Counter.lania.tsx'; // ✅
import { Counter } from './Counter.lania.tsx'; // ❌ 通常没有具名导出
```

### 标签名冲突

`x-counter`、`todo-list` 这类标签名由组件名推导。两个同名组件会导致后注册的被忽略（HMR 下会走原型替换）。库作者建议显式设 `static tagName`。

### 组件在 Shadow DOM 里没升级

自定义元素注册必须发生在元素被创建之前。SSR / 静态 HTML 场景下：

- 确保客户端脚本先执行 `import './components/index'` 完成注册；
- 再做水合或交互。

## 样式问题

### 样式没生效

- 组件默认使用 Shadow DOM，宿主页面的全局样式**不会**穿透进去；
- 用 `Component.styles` 或 `:host` 定义组件内部样式；
- 需要穿透时使用 CSS 自定义属性或 `::part()`。

```ts
import { css } from '@lania-v/runtime';

Counter.styles = css`
  :host {
    display: block;
  }
`;
```

### 样式重复注入

DSD / SSR 与客户端都会注入样式，运行时用 `registerAppliedStyleTexts()` 去重。自定义注入逻辑需要自行登记，否则会出现重复 `<style>`。

## HMR 问题

| 现象               | 原因                                    | 处理                                         |
| ------------------ | --------------------------------------- | -------------------------------------------- |
| 改模板后整页刷新   | 模块没有被 accept                       | 确认开发态注入了 `import.meta.hot.accept()`  |
| 状态丢失           | `hotReload: false`，或新增了 setup 字段 | 保持 `hotReload: true`；新增状态后刷新一次   |
| 改组件名后状态丢失 | 标签名变了，等于换了一个组件            | 组件名保持稳定                               |
| 改样式不更新       | 样式对象是模块级常量                    | 确认 `Component.styles` 在模块求值时重新赋值 |

## SSR 与水合问题

### 首屏没有 Shadow DOM 内容

- 确认用的是 `renderToStringWithDeclarativeShadow()`，而不是只输出 light DOM 的 `renderLightComponent()`；
- 确认组件 `static renderMode` 与输出方式一致；
- 浏览器不支持 DSD 时会由 `attachDeclarativeShadowRoot()` 兜底，前提是客户端组件已经注册。

### Island 不水合

按顺序检查：

1. `hydrateIslands({ components })` 里是否包含该组件；
2. `priorities` 是否覆盖了该 island 的优先级；
3. props 是否可 JSON 序列化（函数 / symbol 会被丢弃并 warning）；
4. 元素上的 `data-lania-island-name` 是否与注册名一致。

### 水合后内容重复

- 服务端与客户端必须使用**同一份**编译产物；
- 不要在客户端重新渲染整棵子树，只让组件接管自己的 shadow root；
- 检查是否有两套运行时或多份样式注入。

## 性能问题

| 症状               | 可能原因                        | 处理                                              |
| ------------------ | ------------------------------- | ------------------------------------------------- |
| 列表更新时整块闪动 | 用了三元 / `&&` 而不是 `<Each>` | 换用增强组件，配稳定 key                          |
| 输入卡顿           | 每次输入触发大范围更新          | 用 `model` 的 `lazy`，或把重计算放进 `createMemo` |
| 首屏很大           | 组件全量静态导入                | 用 `lazy()` / 动态 `import()`                     |
| 事件监听过多       | 每个节点独立监听                | `enableEventDelegation(root)`                     |
| 大量警告拖慢开发   | 调试事件全开                    | 生产构建关闭 `__DEV__`                            |

## 可用的诊断手段

```ts
// 1. 编译快照（需要 debug: true）
__laniaCompile.Counter.ir;
__laniaCompile.Counter.renderPlan;

// 2. 运行时调试钩子
import { registerRuntimeDebugHooks } from '@lania-v/runtime';
const dispose = registerRuntimeDebugHooks({
  onSignalEvent: (event) => console.log('set', event.signalId),
  onSchedulerEvent: (event) => console.log('queue', event.queueSize),
});

// 3. 更新高亮
import { installDevtoolsOverlay } from '@lania-v/runtime/advanced';
const stop = installDevtoolsOverlay();
```

更多用法见 [开发与调试](/guide/dev-and-debug)。

## 报告问题前请收集

- `@lania-v/*` 的版本；
- 相关 `.lania.tsx` 的最小复现；
- Vite overlay 的完整错误与源码帧；
- `debug: true` 下的 `__laniaCompile.<Component>.renderPlan`；
- 运行时的 `registerRuntimeDebugHooks` 输出（如果涉及更新链路）。

## 下一步

- [工程配置](/guide/configuration)：配置项与常见配置错误。
- [构建与部署](/guide/build-and-deploy)：上线后的问题。
- [更新链路](/advanced/update-pipeline)：理解为什么某次更新没有发生。
