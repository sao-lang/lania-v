---
'@lania-v/runtime': minor
'@lania-v/compiler-core': minor
'@lania-v/compiler-tsx': minor
---

`createStore()` 改为与 `createSignal()` 一致的单句柄用法：

- `const store = createStore(initialValue)`，不再返回 `[store, setStore]` 元组；
- 通过 `store.set(...)` 写入，通过 `store.peek()` 读取原始快照；
- 新增点路径写法 `store.set('user.name', 'Grace')`，同时保留分段路径 `store.set('user', 'name', 'Grace')`；
- `produce()` 改为接收 store 句柄；
- 编译器现在直接识别 `const store = createStore(...)` 绑定，并跳过 `store.set` / `store.peek` 的方法读取。
