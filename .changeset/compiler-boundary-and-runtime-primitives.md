---
'@lania-v/runtime': minor
'@lania-v/compiler-core': minor
'@lania-v/compiler-tsx': minor
---

补齐编译边界与运行时原语：

- props 解构会重写为 `this.<prop>` 并保留依赖；同文件 type alias / interface
  / 交叉类型也会被展开；默认值 / rest / 嵌套解构给出明确编译错误。
- 组件标签 spread props 进入运行时 props 表达式；原生标签 spread 改为显式报错。
- 被编译产物引用的模块级声明与 `Component.styles` 等静态配置会保留到输出。
- updater 在挂载与首轮执行时补一次动态依赖发现，覆盖 composable 返回的 signal。
- 新增 `useFormValidity()` 表单校验、`createSelector()`、`startTransition()`、
  `useTransition()`、`produce()`、`createScope()`、`createUniqueId()`、
  `renderToString()` / `renderToStream()` 与 `installDevtoolsOverlay()`。
- 函数型 slot 支持额外参数透传（scoped slot 运行时基础）。
- 新增 `createCompileReportPlugin()` 输出 slot / updater / 依赖统计。
- `bindProps()` / `bindHandlers()` / `bindSlots()` 在编译后的 Custom Element
  路径补齐：props 快照回读实例 signal 并同步更新，函数型 prop 不再被当作
  updater 执行，`bindSlots()` 改从 `children` prop 读取插槽。
- `bindSlots().has(name)` 只判断具名槽本身，不会被默认槽兜底。
- 支持 `defineComponent(fn, { props, emits })`：prop 的 `type` / `attribute` /
  `reflect` / `default` / `converter` / `validator`，以及 `emit()` 事件名单校验。
- `attribute` 未显式声明时，prop 名按 kebab-case 映射到 attribute。
- `DynamicSlot` 会把函数型 child binding 作为 `children` / `slotContent` 透传给
  组件目标，scoped slot 在编译产物中可用。
- 新增增强组件 `Await`（fallback / delay / error / resolve / reject）与
  `Virtual`（固定行高窗口化、overscan、`key`、滚动回调）。
- SSR 新增 Declarative Shadow DOM：`renderToStringWithDeclarativeShadow()`、
  `renderStreamToDeclarativeShadow()`、`renderDeclarativeShadowRoot()`、
  `renderDeclarativeShadowComponent()` 与客户端 `attachDeclarativeShadowRoot()`，
  静态样式会内联进 shadow root 并在 hydration 时去重。
- 新增部分水合 islands 协议：`renderToStringAsIsland()`、`collectIslands()`、
  `hydrateIslands()`、`hydrateIslandElement()`，支持 `eager` / `idle` / `visible` /
  `interaction` 四档优先级与 props 序列化；组件侧用 `static hydration = 'manual'` +
  `hydrate()` 延迟接管。
- 新增开发态组件 HMR：`installComponentHmr()`、`applyComponentHmrUpdate()`、
  `captureComponentState()` / `restoreComponentState()`；Vite 插件在 dev 注入
  `import.meta.hot.accept()`，同名标签重新注册时走原型热替换并保留实例状态。
- `defineComponent(fn, options)` 的选项改为**运行时求值**：编译产物输出
  `static __laniaOptions`，`propOptions` / `emits` / `observedAttributes` 在类求值时推导，
  因此选项里可以使用表达式、导入的常量与函数（不再局限于字面量）。
- props 解构新增默认值、rest（剩余 prop 的 getter 视图）与嵌套路径支持；
  计算属性名仍在编译期报错。
- props 类型支持相对路径导入的具名声明（`import type { CardProps } from './card-props'`）。
- SSR 新增 `renderComponentToString()` / `renderComponentToStream()`，按组件 `renderMode`
  分派输出；light 模式不再包裹 DSD 模板（修复 light DOM + shadow 双份内容）。
- 新增编译期 island 标记 `<Child client:visible />`，配合 `ssrRenderIslandSlot()`
  在 SSR 输出 island 宿主；带 `data-lania-island` 的元素会自动延后水合。
- dev 产物新增可重跑的 `__laniaSetup()`，HMR 可补建新增 setup 状态；
  HMR 下用 MutationObserver 兜底未声明的 attribute。
- BREAKING（编译器内部 AST/IR）：`ComponentDeclaration.propOptions` / `emits`
  被 `optionsSource` 取代，`PropIR` 移除 `propertyType` / `attributeName` / `reflect` /
  `converter*` / `validator`；如果需要这些信息，请从运行时 `static propOptions` 读取。
