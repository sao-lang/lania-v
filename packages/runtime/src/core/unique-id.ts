/**
 * SSR 安全的稳定 ID 生成器。
 *
 * 组件在 service / client 两侧按相同顺序渲染时，会得到一致的序列表；
 * 这足以覆盖 `label for` / `aria-labelledby` 这类常见场景。
 * 不保证并发请求之间的隔离，跨请求场景请由调用方传入显式前缀。
 */
let uniqueIdCounter = 0;

export const createUniqueId = (prefix = 'lania'): string => {
  uniqueIdCounter += 1;
  return `${prefix}-${uniqueIdCounter.toString(36)}`;
};

export const __resetUniqueIdForTests = (): void => {
  uniqueIdCounter = 0;
};
