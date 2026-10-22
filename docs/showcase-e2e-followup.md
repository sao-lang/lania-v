# FC Showcase / e2e 收尾方案（交接文档）

> 这份文档面向"接手继续做"的新会话：先看第 1 节了解现状，再按第 6 节顺序推进。
> 所有结论都来自当前工作树的实测，不是推测。
>
> **状态（2026-10-18）：已收尾。** `tests/e2e/fc-showcase.spec.ts` 6/6 通过，
> `npx vitest run` 248/248 通过，`npm run typecheck` 与改动文件 eslint 均干净。
> 新增的根因与修复见 5.1 ~ 5.4。

---

## 1. 一句话现状（已完成）

`tests/e2e/fc-showcase.spec.ts` **6/6 通过**。最初只剩下 3 个过期断言 + 2 个表面缺陷，
实际收尾时又暴露出 2 个被掩盖的框架缺陷，共 4 处根因：

1. **KeepAlive 子节点是运行时 JSX 时被字符串化**（`[object HTMLDivElement]`）→ 已修
2. **Suspense + `lazy()` 子树完全不渲染**（静默失败）→ 已修；根因是局部组件标签
   没有改写成 `this.LazyHello`，运行时报 `LazyHello is not defined`
3. **嵌套结构型 slot 的锚点与内容被拆开搬运**，Suspense 重新进入 tab 后内容被清空 → 已修
4. **Transition / TransitionGroup 编译成 boundary payload，但运行时没有分发** →
   过渡 hook 从不触发；`ErrorBoundary` 的函数式 fallback 也没有运行时落点 → 已修

另外 `aria-pressed` 那一类失败**已经修好**，不要再去查 `EventSlot` / `AttrSlot`。

---

## 2. 当前验证基线（改之前请先复跑一遍）

```bash
npm run typecheck          # 全 workspace 通过
npx vitest run             # 243/243 通过
npx eslint packages/compiler-tsx/src packages/compiler-core/src packages/runtime/src \
  tests/e2e/fc-showcase.spec.ts                          # 干净
cd playground/todo && npx vite --force                    # 另开终端，http://127.0.0.1:4173
npx playwright test        # 1 passed / 5 failed（全部是 fc-showcase）
```

`npm run bench` 的当前读数（同机同轮，生产构建）：

| Case        | lania-v  | Solid    |
| ----------- | -------- | -------- |
| mount       | 3.995 ms | 1.685 ms |
| text-update | 0.006 ms | 0.005 ms |
| list-patch  | 0.018 ms | 0.043 ms |
| toggle      | 0.006 ms | 0.007 ms |
| model-input | 0.007 ms | 0.006 ms |

---

## 3. 环境陷阱（会直接浪费一小时的那种）

### 3.1 `playground/todo` 跑的是 **dist**，不是 src

`playground/todo/vite.config.ts` 没有任何 runtime alias，走 `node_modules/@lania-v/*` → 包的 `exports` → **dist**。
所以改了 `packages/*/src` 之后必须 build，否则页面行为完全不变：

```bash
npm run build:compiler    # compiler-core + compiler-tsx + vite-plugin
npm run build:runtime     # runtime
```

`playground/benchmark` 则相反：它的 `vite.config.ts` 把 `@lania-v/runtime` alias 到 **src**，改运行时即时生效。

### 3.2 浏览器栈里的 `packages/.../src/xxx.ts` 是 sourcemap 映射

实际执行的是 dist。**不要**据此判断"改 src 没生效"。

### 3.3 e2e 在 Windows 下起不来 webServer

`playwright.config.ts` 的 `webServer.command` 用了 `NODE_OPTIONS=...` 前缀，cmd 无法执行。
绕过方式：**手动起 dev server**（`cd playground/todo && npx vite --force`），
`reuseExistingServer: true` 会让 Playwright 复用它。注意必须真的返回 200，404 会被判定为"未就绪"。

### 3.4 Playwright locator 能穿透 Shadow DOM，`document.querySelector` 不能

FC 组件默认 `renderMode = 'shadow'`。调试页面内容请用 `page.locator('.list')`，
不要在 `page.evaluate` 里用 `document.querySelector('.filters')`（永远 null）。

### 3.5 工作树里有别人的未提交改动 —— 不要动

- `.github/*`（删除）、`.gitignore`、`README.md`、`package-lock.json`
- `packages/vite-plugin/src/index.ts`、`tests/runtime-debug.test.ts`、`tests/vite-plugin-debug-trace.test.ts`
- `packages/runtime/src/{core/debug.ts,dom/updaters.ts,reactivity/signal.ts}` 中的 debug/trace 主体实现
- `playground/login/*`、`playground/mouse-hook/*`、`tests/playground-mouse-snapshot.test.ts`
- `docs/getting-started.md`、`tests/compiler-tsx-module-output.test.ts`

`playground/benchmark/src/main.tsx` 是**混合文件**：本轮的 settle 修复与对方的新 UI 改动都在里面，
改动前先看 diff，不要整文件回滚。

另外 `npm run lint`（全仓 eslint）目前是红的：`packages/runtime/src/**` 里有一批未使用的类型/函数导入
（KeepAlive、TransitionGroup 相关的重构残留），属于他人的进行中工作，**不要顺手清理**。
只需要保证自己改动的文件 eslint 干净即可。

---

## 4. 本轮已经修完的根因（不要重复排查）

| #   | 现象                                                         | 根因                                                                                      | 落点                                                                                                                                                                                       |
| --- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `bindProps is not defined` / `provideContext is not defined` | 用户 `.lania.tsx` 里的 runtime 具名导入被整体过滤，只按固定白名单重新解构                 | `compiler-tsx/src/compile/module-output.ts`（收集用户导入并合并注入）                                                                                                                      |
| 2   | `Template node path "0.x" was not found`                     | Boundary / Transition 子树被抽成独立模板，但 binding 仍用父模板坐标                       | `compiler-core/.../lower-boundaries.ts`（子模板 path 从 `[]` 起算）                                                                                                                        |
| 3   | `props is not defined`                                       | `bindProps(props)` 在字段初始化期执行，props 要等构造完才赋值                             | `runtime/.../function-component.ts`（构造期 props 栈 + `getComponentCreationProps`）、`compiler-tsx/src/parse/function/index.ts`（注入 `props` 字段）、`component-slot.ts`（首建带 props） |
| 4   | `<this.p>` 非法标签                                          | props 别名/局部绑定改写没有排除 JSX tag / attribute 名                                    | `compiler-tsx/src/parse/function/bindings.ts`                                                                                                                                              |
| 5   | `count: 0\| doubled:0` 少空格                                | TS 把 `</span>` 之后的前导空格算作前一个 token 的 trivia，`getText()` 拿不到              | `compiler-tsx/src/parse/template.ts`（改用 `getFullText`）                                                                                                                                 |
| 6   | `{' '}` 渲染为空                                             | 常量折叠成 `TextIR`，但 block 模板 HTML 在 lowering 阶段已固化，占位符留下而 binding 没了 | `compiler-core/src/transform/optimization/template.ts`（block 模板内不折叠）                                                                                                               |
| 7   | keyed 列表项 `classname="x"`                                 | 静态属性拼接沿用了 JSX 的 `className`                                                     | `compiler-core/.../helpers/keyed-each.ts`                                                                                                                                                  |

同时修掉的测试/工程问题：

- `tests/enhanced-registry-contract.test.ts`：注册表补 `Slot`
- `vitest.config.ts`：补 `@lania-v/runtime/core`、`/reactivity` alias（根 alias 是前缀匹配，会把子路径拼坏）
- `tests/runtime-bundling.test.ts`：去掉硬编码 macOS 路径；dev/prod 入口断言改为读同一份 dist 模块
- `boundary-slot.ts`：删除 3 个未使用导入

---

## 5. 三个待办问题

### 5.1 问题 A：KeepAlive 的运行时 JSX 被字符串化（真 bug）

#### 证据（问题 A）

- 源码 `playground/todo/src/FcShowcase.lania.tsx:323`：

  ```tsx
  const keepAliveViews = createSignal({
    pageA: <div data-key="page-a">…</div>,
    pageB: <div data-key="page-b">…</div>,
  });
  ```

- 使用处 `:1354`：`<KeepAlive …>{keepAliveKey() === 'page-a' ? keepAliveViews().pageA : …}</KeepAlive>`
- 编译产物：

  ```js
  template: "__LANIA_SLOT_0__",
  bindings: [{ kind: "text", slotIndex: 0, path: [0], evaluate: () => keepAliveViews().pageA }]
  ```

- 运行时 `TextSlot.write()` 把 `HTMLDivElement` 转成字符串 → 页面出现 `[object HTMLDivElement]`，
  连带 `placeholder="type in Page A"` 的输入框根本不存在。

#### 影响用例

- `preserves KeepAlive state`
- `resets Enhanced state when re-entering the tab`

#### 方案 A（推荐）：让文本槽识别节点值

落点 `packages/runtime/src/dom/slots/core.ts`（`TextSlot`）+ `template-factory.ts`（`commitBindingValue`）。

思路：`TextSlot` 的 `node` 本身是稳定的位置锚点，不要换成注释，避免 `slot.node` 身份失效。
在写节点时把注入内容挂在文本节点**之后**，并把文本置空；写回普通值时移除注入节点、恢复文本。

```ts
// 伪代码
class TextSlot {
  private injected: Node[] = [];
  write(value: unknown): void {
    if (isNodeLike(value)) {
      // Node | DocumentFragment | Node[]
      this.clearInjected();
      this.injected = normalizeDynamicResult(value);
      const parent = this.node.parentNode;
      let anchor: Node = this.node;
      for (const n of this.injected)
        (parent.insertBefore(n, anchor.nextSibling), (anchor = n));
      this.node.data = '';
      this.previous = '';
      return;
    }
    this.clearInjected();
    // …原有字符串写入逻辑
  }
}
```

必须处理的细节：

- `isNodeLike` 要覆盖 `Node`、`DocumentFragment`、以及**只包含 Node 的数组**（`bindSlots().render()` 也走这条）。
- `destroy()` 必须移除 `injected`。
- `MountedBindingInstance.nodes` / `ForSlot` 的 block 区间要能覆盖注入节点，否则 KeepAlive 缓存、keyed 删除会漏节点
  （`readMountedNodes`、`collectKeyedBlockNodes` 都要看一眼）。
- `TextSlot` 的等值短路（`previous === nextValue`）对节点值要跳过。
- 回归面很大：所有文本绑定都走这里。至少覆盖
  `tests/runtime-slot.test.ts`、`tests/runtime-render.test.ts`、`tests/runtime-function-component.test.ts`。

#### 方案 B：编译期在节点容器里把表达式子节点降级为 `dynamic`

落点 `compiler-core/src/ir/component/lowering/template-lowering.ts`。
对 `KeepAlive` / `Dynamic` 这类"子节点按节点渲染"的容器，`ExpressionIR` 改为 `DynamicIR`。

- 优点：复用现成的 `DynamicSlot` 与 `normalizeDynamicResult`，`TextSlot` 语义完全不动。
- 缺点：编译器无法静态判断值类型，纯字符串表达式会多付 `DynamicSlot` 的开销与两个注释锚点；
  `When/Then` 等分支容器要不要一起处理需要额外判断。

**建议**：先做方案 A 的最小实现（只覆盖 `Node` / `DocumentFragment` / Node 数组），跑全量单测；
如果回归面过大，再退回方案 B 并只在 KeepAlive/Dynamic 容器启用。

#### 验收（问题 A）

- 上述 2 个 e2e 用例通过
- 新增单测：`TextSlot` 写入 `Element` 后 DOM 中出现真实节点、写回字符串能恢复、`destroy()` 清理干净

---

### 5.2 问题 B：Suspense + `lazy()` 子树完全不渲染（真 bug）

#### 证据（问题 B）

`Suspense` tab 的完整文本（Playwright 实测）：

```text
<Suspense /> + lazy() + <LazyLoad /> name=lania  name=runtime  toggle error <LazyLoad />lazyload placeholder
```

也就是说：

- `<ErrorBoundary><Suspense fallback={…}><When>…</When></Suspense></ErrorBoundary>` 这一段**没有任何内容**
- 连 `loading...` fallback 都没出现
- **没有 `pageerror`、没有 console 报错**（静默失败）

源码位置：`playground/todo/src/FcShowcase.lania.tsx:1393-1408`。

编译侧上一轮已修：boundary payload 的嵌套 bindings 现在是 `path: [0]`（与子模板一致）。
所以不要再怀疑 path 错位。

**复现脚本**（放到 `tests/e2e/tmp-debug.spec.ts`，用完删除）

```ts
import { test } from '@playwright/test';

test('debug suspense', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForSelector('.filters');
  await page
    .locator('.filters')
    .getByRole('button', { name: 'Suspense', exact: true })
    .click();
  await page.waitForTimeout(400);
  console.log(await page.locator('.list').textContent());
  console.log('errors:', errors);
});
```

#### 排查清单（按顺序打点）

1. `boundary-slot.ts` 的 `write()` 是否走进了 `writeSuspense` / `writeErrorBoundary` 分支；
   `activeBranch`、`lastValue`、`hydratedBoundary` 的实际值。
2. `renderChild()` → `ensureChildInstance()` 是否被调用，`bindings` 长度与 `childTemplate.html`。
3. `readBoundaryBlock(value)` 是否拿到 payload（`__lania_boundary` 标记、`component` 字段）。
4. `When` 的 `Then` 子节点是否被 lowering 成 block；`Then` 里是 `<LazyHello …/>`（组件 + `lazy()`）。
5. `lazy()` 的 Promise 解析路径：`component/enhanced-components/async.ts`、`lifecycle/boundary-registry.ts`
   里 `isThenable(error)` 的分支有没有把实例吞掉。
6. 注意 loader 抛出的 Promise 会被 `mountWithHydrationFallback` 的 catch 捕获并**重新 throw**；
   确认外层有人接住并设置了 fallback 状态。

#### 可能落点

- `packages/runtime/src/dom/slots/boundary-slot.ts`
- `packages/runtime/src/component/lifecycle/boundary-registry.ts`
- `packages/runtime/src/component/enhanced-components/async.ts`
- `packages/compiler-core/src/ir/component/lowering/lower-boundaries.ts`

#### 验收（问题 B）

- Suspense 区域能出现 `loading...`，随后出现 `Lazy component resolved: world`（默认值见源码 `lazyName`）
- 修好后 `resets Suspense state` 用例的前半段才有意义（后半段仍需按 5.3 更新断言）

---

### 5.3 问题 C：3 个 e2e 用例是**过期测试**（简单，零框架风险）

只改 `tests/e2e/fc-showcase.spec.ts`。

#### C1. `runs TransitionGroup list interactions`

| 现状                                                                                   | 断言                                                                                 |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `count: 3 \| ids: a, b, c` 属于 **Store** demo（`store.list ids:`），Transition 页没有 | 改为断言窗口内出现 `A`/`B`/`C` 三个 chip，以及 `move:*` / `leave:*` / `enter:*` 日志 |
| 按钮是 `append item` / `move first` / `remove first`                                   | 不再点 `reverse` / `pop` / `push`（这三个按钮不存在）                                |

#### C2. `handles ErrorBoundary reset`

| 现状                                                                        | 断言                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 按钮是 `toggle error`（不是 `toggle throw: false/true`），没有 `reset` 按钮 | 改为点击 `toggle error`，断言 `caught: manual suspense demo error` |

#### C3. `resets Suspense state when re-entering the tab`

| 现状                                 | 断言                                                       |
| ------------------------------------ | ---------------------------------------------------------- |
| 按钮是 `name=lania` / `name=runtime` | 点击后断言 `Lazy component resolved: lania` / `…: runtime` |

已完成的小改动（保留）：`runs reactivity smoke flow` 里 `count:` 的 locator 已收窄到 `.list`，
因为首页同时渲染了 `FcBindingApiDemo`，它也有一个 `count:` 文本。

### 5.4 收尾时补修的根因（2026-10-18）

| #   | 现象                                          | 根因                                                               | 落点                                                                                                                                        |
| --- | --------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `LazyHello is not defined`，Suspense 子树空白 | 局部组件绑定被提升为 `this.LazyHello`，但 JSX 标签名不走表达式重写 | `compiler-tsx/src/parse/function/bindings.ts`（改写 `ElementNode.tagName`）、`compiler-core/.../lower-dynamic.ts`（接受 `this.X` 组件引用） |
| 2   | KeepAlive 只移动空文本占位符                  | `TextSlot` 注入的节点不在 `MountedBindingInstance.nodes` 里        | `runtime/.../slots/core.ts`（`injectedNodes` + `currentNodes`）、`template-factory.ts`（存在注入节点时按区间收集）                          |
| 3   | 重新进入 Suspense tab 后内容被清空            | `readMountedNodes` 只返回结构节点，丢失嵌套 slot 的锚点            | `runtime/.../template/template-types.ts`（锚点与结构节点按文档顺序合并）                                                                    |
| 4   | TransitionGroup 的 enter/leave/move 从不触发  | `TransitionIR` 被编译成 boundary payload，`BoundarySlot` 未分发    | `runtime/.../slots/boundary-slot.ts`（`renderTransition` / `renderGroup`）                                                                  |
| 5   | `caught: …` 不渲染                            | `ErrorBoundary` 的函数式 fallback 无法静态成模板，也未进入 payload | `compiler-core/.../helpers/payload.ts`（`metadata.fallback` 原始表达式）+ `boundary-slot.ts`（运行时求值）                                  |

新增测试：

- `tests/runtime-slot.test.ts`：TextSlot 注入 Element / Node 数组、恢复文本、`destroy()` 清理；ErrorBoundary 函数式 fallback。
- `tests/compiler-plugin.test.ts`：局部组件标签生成 `component: this.LazyHello`。

---

## 6. 建议执行顺序

1. **更新过期测试（C1~C3）** — 立刻把噪音降到 2 个真实失败，且能看清 A/B 的进展。
2. **修问题 A** — 方案 A 最小实现 + 全量单测回归。
3. **修问题 B** — 先取证（5.2 的排查清单），再动代码；这块不确定性最高，不要在没拿到证据前改运行时。
4. 收尾：`npm run typecheck` → `npx vitest run` → `npx playwright test` → 如需重跑 `npm run bench`。

每步的质量门：

```bash
npm run typecheck
npx vitest run
npx eslint <改动文件>
npx playwright test
```

完成标准：`tests/e2e/fc-showcase.spec.ts` **6/6 通过**，`npx vitest run` 仍为 243+ 全绿。

> 2026-10-18 已达到：e2e 6/6、`npx vitest run` 248/248、workspace typecheck 与改动文件 eslint 均干净。

---

## 7. 不要做的事

- 不要引入虚拟 DOM / 整树 diff。
- 不要为了过 e2e 修改 demo 的语义（`playground/todo/src/*.lania.tsx` 是验收面，不是被测代码）。
- 不要改 `playground/benchmark` 的场景参数（列表规模、操作次数、校验方式），那会让历史读数失效。
- 不要回滚第 4 节列出的既有修复。
- 不要动第 3.5 节列出的他人未提交改动。
