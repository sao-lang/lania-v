---
'@lania-v/compiler-core': patch
'@lania-v/compiler-tsx': patch
---

修复三处影响运行期正确性的编译缺陷：

- signal 与 setup 字段现在按组件体源码顺序初始化，避免 `const a = read(); const b = createSignal(a)` 在构造期读取未赋值字段。
- `!expr` 等一元运算下的读取不再被当成写入，属性绑定可以正确订阅依赖。
- computed 依赖会递归展开到叶子 signal，嵌套 computed 链上的绑定不会再漏订阅。
