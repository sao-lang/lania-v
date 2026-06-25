/**
 * `class` 绑定值的归一化与写回工具。
 *
 * 这个文件负责把模板层允许出现的多种 class 形态统一压平成标准字符串，包括：
 * - 原始字符串：`"foo bar"`
 * - 数字：会先转成字符串再参与拆分
 * - 对象：`{ active: condition }`
 * - 数组：允许任意层级嵌套上述结构
 *
 * 运行时最终只和标准 `class=""` 字符串打交道，这样 DOM、SSR 和 hydration 都能复用
 * 同一套归一化规则，避免不同渲染路径对 class 合并结果产生分歧。
 */
export type ClassValue =
  | string
  | number
  | null
  | undefined
  | false
  | Record<string, unknown>
  | readonly ClassValue[];

const collectClassTokens = (value: unknown, tokens: string[]): void => {
  if (value == null || value === false) {
    return;
  }

  if (Array.isArray(value)) {
    // 数组只是组合容器，递归展开后继续沿用同一份 token 缓冲区。
    value.forEach((entry) => collectClassTokens(entry, tokens));
    return;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    // 字符串里允许一次声明多个 class，按空白符切开后逐个收集。
    String(value)
      .split(/\s+/)
      .filter((token) => token.length > 0)
      .forEach((token) => tokens.push(token));
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  Object.entries(value as Record<string, unknown>).forEach(([key, enabled]) => {
    if (!enabled) {
      return;
    }

    // 对象键也可能自带空格，因此仍走一遍递归拆分，保持各种输入形态结果一致。
    collectClassTokens(key, tokens);
  });
};

export const normalizeClassValue = (value: unknown): string => {
  const tokens: string[] = [];
  collectClassTokens(value, tokens);
  return tokens.join(' ');
};

export const mergeClassValues = (baseValue: unknown, dynamicValue: unknown): string => {
  return normalizeClassValue([baseValue, dynamicValue]);
};

export const writeClassAttribute = (
  element: Element,
  value: unknown,
  baseValue: unknown = ''
): void => {
  // 静态 class 与动态 class 统一先合并，再决定是 set 还是 remove。
  const normalized = mergeClassValues(baseValue, value);

  if (normalized.length === 0) {
    element.removeAttribute('class');
    return;
  }

  element.setAttribute('class', normalized);
};
