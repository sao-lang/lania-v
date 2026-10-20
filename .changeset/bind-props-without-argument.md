---
'@lania-v/runtime': minor
'@lania-v/compiler-tsx': minor
---

`bindProps()` / `bindHandlers()` 改为纯无参签名：

- 未编译的函数组件由 JSX 运行时在调用前注入当前 props 上下文；
- `.lania.tsx` 编译产物会改写成内部工厂 `createBoundProps(this.props)` /
  `createBoundHandlers(this.props)`，手动创建元素、SSR 升级与 HMR 重跑 `setup`
  都能拿到实例快照；
- 不再接受显式 props 参数，组件上下文之外调用会直接报错；
- 手动创建的元素会从 `static handlerKeys` 补 metadata，回调尚未赋值时也能稳定分流。
