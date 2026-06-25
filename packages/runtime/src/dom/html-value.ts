/**
 * 原始 HTML 片段包装与消费工具。
 *
 * 运行时不会直接接受任意字符串作为 `html` 指令输入，而是要求调用方通过
 * `html\`...\`` 显式声明“这是一段可直接注入的 HTML”。这样可以把普通文本绑定和
 * 原始 HTML 绑定分开处理，减少误用。
 *
 * 这里的职责很单一：
 * - 提供 `HtmlResult` 品牌类型；
 * - 负责模板字符串插值归一化；
 * - 在真正写入 `innerHTML` 前做类型校验与告警。
 */
import { warning } from '../core/debug';

export interface HtmlResult {
  readonly kind: 'html-result';
  readonly htmlText: string;
  toString(): string;
}

export type HtmlBindingValue = HtmlResult | null | undefined;

const createHtmlResult = (htmlText: string): HtmlResult => {
  return {
    kind: 'html-result',
    htmlText,
    toString() {
      return htmlText;
    },
  };
};

const normalizeTemplateValue = (value: unknown): string => {
  if (value == null || value === false) {
    return '';
  }

  if (isHtmlResult(value)) {
    // 允许嵌套 html`...` 片段，直接透传内部 htmlText。
    return value.htmlText;
  }

  return String(value);
};

export const isHtmlResult = (value: unknown): value is HtmlResult => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value as { kind?: unknown }).kind === 'html-result'
  );
};

export const getHtmlText = (value: HtmlBindingValue): string => {
  return value == null ? '' : value.htmlText;
};

export const resolveHtmlBindingText = (value: unknown): string => {
  if (value == null) {
    return '';
  }

  if (isHtmlResult(value)) {
    return value.htmlText;
  }

  // 明确拒绝普通字符串，避免把原本应该走文本转义的内容误注入为 HTML。
  warning('The "html" directive only accepts values created by html`...`.', false);
  return '';
};

export const applyHtml = (target: HTMLElement, value: unknown): void => {
  target.innerHTML = resolveHtmlBindingText(value);
};

export const html = (
  strings: TemplateStringsArray,
  ...values: unknown[]
): HtmlResult => {
  // 与 `css` 类似，模板字符串在运行时只负责简单拼接，不额外做转义。
  const htmlText = strings.reduce((result, chunk, index) => {
    return result + chunk + normalizeTemplateValue(values[index]);
  }, '');

  return createHtmlResult(htmlText);
};
