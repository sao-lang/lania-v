/**
 * `@lania-v/runtime/reactivity` 公共入口。
 *
 * 响应式核心随 runtime 一起分发，但不从 runtime 一级入口导出，
 * 需要显式按此路径引入：
 *
 * ```ts
 * import { createSignal, createEffect } from '@lania-v/runtime/reactivity';
 * ```
 */
export * from '../reactivity';
