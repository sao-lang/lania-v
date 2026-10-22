/**
 * `style` 绑定值的归一化与合并工具。
 *
 * 模板层允许把 style 写成：
 * - 原始内联样式字符串
 * - 对象：`{ color: 'red', fontSize: 12 }`
 * - 数组：用于组合多段字符串或对象样式
 *
 * 这里会把这些输入全部收敛成 `property: value;` 形式的声明表，再统一序列化成
 * attribute 字符串。这样 SSR 输出、DOM patch 和静态/动态样式合并都共享同一套规则。
 */
import {
  normalizeStyleName,
  serializeStyleValue,
  type CSSProperties,
  type StylePrimitive,
} from '../component/styles';

export type StyleBindingValue =
  | string
  | null
  | undefined
  | false
  | CSSProperties
  | readonly StyleBindingValue[];

const parseStyleText = (
  value: string,
  declarations: Map<string, string>
): void => {
  value
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .forEach((entry) => {
      const separatorIndex = entry.indexOf(':');
      if (separatorIndex < 0) {
        return;
      }

      // 字符串样式的后写声明覆盖先前声明，行为尽量贴近浏览器的内联样式解析习惯。
      const property = entry.slice(0, separatorIndex).trim();
      const propertyValue = entry.slice(separatorIndex + 1).trim();
      if (property.length === 0) {
        return;
      }

      if (propertyValue.length === 0) {
        declarations.delete(property);
        return;
      }

      declarations.set(property, propertyValue);
    });
};

const collectStyleDeclarations = (
  value: unknown,
  declarations: Map<string, string>
): void => {
  if (value == null || value === false) {
    return;
  }

  if (Array.isArray(value)) {
    // 数组表示“按顺序合并多段样式”，后面的同名属性自然覆盖前面。
    value.forEach((entry) => collectStyleDeclarations(entry, declarations));
    return;
  }

  if (typeof value === 'string') {
    parseStyleText(value, declarations);
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  Object.entries(value as Record<string, StylePrimitive>).forEach(
    ([property, propertyValue]) => {
      // 对象输入先做属性名归一化，再沿用组件样式层的序列化规则。
      const normalizedProperty = normalizeStyleName(property);
      const serializedValue = serializeStyleValue(propertyValue);

      if (serializedValue === null) {
        declarations.delete(normalizedProperty);
        return;
      }

      declarations.set(normalizedProperty, serializedValue);
    }
  );
};

const serializeStyleDeclarations = (
  declarations: Map<string, string>
): string => {
  return [...declarations.entries()]
    .map(([property, value]) => `${property}: ${value};`)
    .join(' ');
};

export const normalizeStyleValue = (value: unknown): string => {
  const declarations = new Map<string, string>();
  collectStyleDeclarations(value, declarations);
  return serializeStyleDeclarations(declarations);
};

export const mergeStyleValues = (
  baseValue: unknown,
  dynamicValue: unknown
): string => {
  const declarations = new Map<string, string>();
  // 先放静态值，再应用动态值，保证动态绑定拥有更高优先级。
  collectStyleDeclarations(baseValue, declarations);
  collectStyleDeclarations(dynamicValue, declarations);
  return serializeStyleDeclarations(declarations);
};

export const writeStyleAttribute = (
  element: Element,
  value: unknown,
  baseValue: unknown = ''
): void => {
  const normalized = mergeStyleValues(baseValue, value);

  if (normalized.length === 0) {
    element.removeAttribute('style');
    return;
  }

  element.setAttribute('style', normalized);
};
