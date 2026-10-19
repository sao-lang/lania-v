---
'@lania-v/runtime': minor
'@lania-v/compiler-tsx': minor
---

收敛 Context / Transition 公共 API：

- `provideContextHere(context, value)` 合并为 `provideContext(context, value)` 两参重载，编译器仍会改写成 `provideContext(this, ...)`。
- `consumeContext` / `consumeContextValue` 不再从公共入口导出；组件外使用 `useContext(context, host)`。
- `transitionPending` 不再单独导出，改用 `useTransition().pending`。
- 移除顶层 `createTransition`；高级场景使用 `defaultScheduler.createTransition()`。
- `component` 入口不再导出 Transition 提交协议内部类型。
- 移除主题别名 `ThemeContext` / `provideTheme` / `consumeTheme` / `createThemeVariables` / `applyThemeVariables` / `ThemeVariables`。
