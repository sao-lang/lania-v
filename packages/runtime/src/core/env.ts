/**
 * 解析运行时当前是否处于开发模式。
 *
 * 优先读取构建注入的 `__LANIA_DEV__`，否则退回 `process.env.NODE_ENV` 推断。
 */
declare const __LANIA_DEV__: boolean | undefined;

export const __DEV__ =
  typeof __LANIA_DEV__ === 'boolean'
    ? __LANIA_DEV__
    : typeof process === 'undefined' || process.env.NODE_ENV !== 'production';
