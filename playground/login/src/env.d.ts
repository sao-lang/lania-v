/// <reference types="vite/client" />

declare module '*.lania.tsx' {
  // 编译产物是自定义元素构造器，并额外携带 `styles` 等运行时可写元信息。
  const component: import('@lania-v/runtime').ComponentElementConstructor;
  export default component;
}
