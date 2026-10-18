/**
 * 组件样式与 CSS 变量工具集。
 *
 * 这里统一处理三类能力：
 * - `css\`...\``：把模板字符串包装成可复用的样式值
 * - 样式对象/CSS 变量：把 JS 结构转换成标准 CSS 属性和值
 * - 样式注入：优先走 `adoptedStyleSheets`，不支持时回退到 `<style>` 标签
 *
 * 文件既服务于组件静态样式，也服务于运行时 CSS 变量注入，因此会同时暴露样式文本、
 * `CSSStyleSheet` 和 context 相关能力。
 */
import type * as CSS from 'csstype';
import { consumeContext, createContext, provideContext } from '../core/context';

export interface CSSResult {
  readonly kind: 'css-result';
  readonly cssText: string;
  toString(): string;
}

export type StyleValue = CSSStyleSheet | CSSResult;
export type StaticStyles = StyleValue | StyleValue[];
export type StylePrimitive = string | number | boolean | null | undefined;
type CSSPropertyDefinitions =
  CSS.Properties<string | number> &
  CSS.PropertiesHyphen<string | number>;

export type CSSProperties = {
  [K in keyof CSSPropertyDefinitions]?: CSSPropertyDefinitions[K] | null | undefined | false;
} & {
  [propertyName: `--${string}`]: StylePrimitive;
};

// Internal shape remains permissive because runtime accepts arbitrary property names.
export type StyleObject = Record<string, StylePrimitive>;
export type CSSVariables = Record<string, StylePrimitive>;

const STYLESHEET_TEXT = new WeakMap<CSSStyleSheet, string>();
const APPLIED_STYLE_TEXT = new WeakMap<object, Set<string>>();
export const StyleVariablesContext = createContext<CSSVariables>({}, 'lania-style-variables');

const normalizeTemplateValue = (value: unknown): string => {
  if (value == null) {
    return '';
  }

  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }

  if (isCSSResult(value)) {
    return value.cssText;
  }

  return String(value);
};

const createCSSResult = (cssText: string): CSSResult => {
  return {
    kind: 'css-result',
    cssText,
    toString() {
      return cssText;
    },
  };
};

const createConstructedStyleSheet = (cssText: string): CSSStyleSheet | null => {
  if (typeof CSSStyleSheet === 'undefined') {
    return null;
  }

  try {
    const sheet = new CSSStyleSheet();

    if (!('replaceSync' in sheet) || typeof sheet.replaceSync !== 'function') {
      return null;
    }

    // 记录原始文本，便于后续在不支持 adoptedStyleSheets 的分支回退成 `<style>`。
    sheet.replaceSync(cssText);
    STYLESHEET_TEXT.set(sheet, cssText);
    return sheet;
  } catch {
    return null;
  }
};

const getAppliedTexts = (root: object): Set<string> => {
  let existing = APPLIED_STYLE_TEXT.get(root);

  if (!existing) {
    // 按宿主 root 去重，避免同一份静态样式被重复注入。
    existing = new Set<string>();
    APPLIED_STYLE_TEXT.set(root, existing);
  }

  return existing;
};

const supportsAdoptedStyleSheets = (
  root: ShadowRoot | HTMLElement
): root is ShadowRoot & { adoptedStyleSheets: CSSStyleSheet[] } => {
  return 'adoptedStyleSheets' in root;
};

export const isCSSResult = (value: unknown): value is CSSResult => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value as { kind?: unknown }).kind === 'css-result'
  );
};

export const getStyleText = (style: StyleValue): string => {
  if (isCSSResult(style)) {
    return style.cssText;
  }

  return STYLESHEET_TEXT.get(style) ?? '';
};

export const normalizeStyleName = (name: string): string => {
  if (name.startsWith('--')) {
    return name;
  }

  // JS 侧常用 camelCase，写入 CSS 前统一转为 kebab-case。
  return name.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
};

export const serializeStyleValue = (
  value: StylePrimitive,
  unit = ''
): string | null => {
  if (value == null || value === false || value === '') {
    return null;
  }

  if (value === true) {
    return '';
  }

  return `${String(value)}${unit}`;
};

export const applyStyleValue = (
  target: HTMLElement,
  property: string,
  value: StylePrimitive,
  unit = ''
): void => {
  const normalizedProperty = normalizeStyleName(property);
  const serialized = serializeStyleValue(value, unit);

  if (serialized === null) {
    target.style.removeProperty(normalizedProperty);
    return;
  }

  target.style.setProperty(normalizedProperty, serialized);
};

export const applyStyleObject = (
  target: HTMLElement,
  next: StyleObject,
  previous: StyleObject = {}
): StyleObject => {
  const previousKeys = new Set(Object.keys(previous));

  for (const [property, value] of Object.entries(next)) {
    applyStyleValue(target, property, value);
    previousKeys.delete(property);
  }

  for (const property of previousKeys) {
    // 新对象里已消失的属性需要显式移除，避免旧样式残留。
    applyStyleValue(target, property, null);
  }

  return { ...next };
};

export const createCSSVariables = (variables: CSSVariables): StyleObject => {
  return Object.fromEntries(
    Object.entries(variables).map(([key, value]) => {
      // 变量键统一映射成 CSS 变量，调用方可直接传 `primaryColor` 或 `--primary-color`。
      return [key.startsWith('--') ? key : `--${normalizeStyleName(key)}`, value];
    })
  );
};

export const applyCSSVariables = (
  target: HTMLElement,
  variables: CSSVariables,
  previous: CSSVariables = {}
): CSSVariables => {
  applyStyleObject(
    target,
    createCSSVariables(variables),
    createCSSVariables(previous)
  );

  return { ...variables };
};

export const provideStyleVariables = (
  host: HTMLElement,
  variables: CSSVariables
): (() => void) => {
  // 提供 context 的同时立即把变量落到宿主元素，保证样式可立刻生效。
  applyCSSVariables(host, variables);
  return provideContext(host, StyleVariablesContext, variables);
};

export const consumeStyleVariables = (
  host: { dispatchEvent(event: Event): boolean }
): CSSVariables => {
  return consumeContext(host, StyleVariablesContext)();
};

// Backward-compatible aliases for older "theme" terminology.
export type ThemeVariables = CSSVariables;
export const ThemeContext = StyleVariablesContext;
export const createThemeVariables = createCSSVariables;
export const applyThemeVariables = applyCSSVariables;
export const provideTheme = provideStyleVariables;
export const consumeTheme = consumeStyleVariables;

export const toStyleArray = (styles: StaticStyles | undefined): StyleValue[] => {
  if (!styles) {
    return [];
  }

  return Array.isArray(styles) ? styles : [styles];
};

export const css = (
  strings: TemplateStringsArray,
  ...values: unknown[]
): StyleValue => {
  // 模板插值阶段只做字符串拼接，是否构造成 StyleSheet 取决于宿主环境能力。
  const cssText = strings.reduce((result, chunk, index) => {
    return result + chunk + normalizeTemplateValue(values[index]);
  }, '');

  return createConstructedStyleSheet(cssText) ?? createCSSResult(cssText);
};

/**
 * 把静态样式摊平成可直接序列化进 SSR 的 CSS 文本。
 *
 * 服务端没有构造式样式表，因此这里只做文本提取，样式表顺序保持声明顺序。
 */
export const resolveStaticStyleText = (
  styles: StaticStyles | undefined
): string => {
  return toStyleArray(styles)
    .map((style) => getStyleText(style))
    .filter((cssText) => cssText.length > 0)
    .join('\n');
};

/**
 * 把 root 里已经存在的 `<style>` 文本登记为“已注入”。
 *
 * Declarative Shadow DOM 的 SSR 输出已经把样式写进 shadow root，
 * 客户端 hydration 时不需要再注入一遍。
 */
export const registerAppliedStyleTexts = (
  root: ShadowRoot | HTMLElement
): void => {
  const appliedTexts = getAppliedTexts(root);
  const styleElements = root.querySelectorAll('style');

  styleElements.forEach((styleElement) => {
    const cssText = styleElement.textContent ?? '';
    if (cssText.length > 0) {
      appliedTexts.add(cssText);
    }
  });
};

export const adoptStyles = (
  root: ShadowRoot | HTMLElement,
  styles: StaticStyles | undefined
): void => {
  const styleValues = toStyleArray(styles);

  if (styleValues.length === 0) {
    return;
  }

  const appliedTexts = getAppliedTexts(root);
  const nextStyles = styleValues.filter((style) => {
    const cssText = getStyleText(style);

    if (!cssText || appliedTexts.has(cssText)) {
      return false;
    }

    appliedTexts.add(cssText);
    return true;
  });

  if (nextStyles.length === 0) {
    return;
  }

  if (supportsAdoptedStyleSheets(root)) {
    const sheets = nextStyles
      .map((style) => {
        if (style instanceof CSSStyleSheet) {
          return style;
        }

        return createConstructedStyleSheet(style.cssText);
      })
      .filter((sheet): sheet is CSSStyleSheet => Boolean(sheet));

    if (sheets.length > 0) {
      // 优先复用构造式样式表，减少 DOM 节点数量，也更适合 ShadowRoot。
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, ...sheets];
      return;
    }
  }

  for (const style of nextStyles) {
    // 回退路径：普通 HTMLElement 或不支持 adoptedStyleSheets 的环境。
    const styleElement = document.createElement('style');
    styleElement.textContent = getStyleText(style);
    root.appendChild(styleElement);
  }
};
