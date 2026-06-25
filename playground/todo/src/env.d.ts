/// <reference types="vite/client" />

declare module '*.lania.tsx' {
  const component: CustomElementConstructor;
  export default component;
}
