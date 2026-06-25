/**
 * 暴露开发态 JSX runtime 入口。
 *
 * 当前直接复用标准 `jsx-runtime` 实现，只保留 dev 入口命名以兼容工具链。
 */
export { Fragment, jsx, jsxs, jsxDEV } from './jsx-runtime';
export type { JsxElement, JsxProps, LaniaJsxElement } from './jsx-runtime';
