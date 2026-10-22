/**
 * Declarative Shadow DOM（DSD）SSR / hydration 协议。
 *
 * 这一层把“编译产物输出的 HTML 字符串”包装成浏览器可以直接解析的
 * `<template shadowrootmode="open">`，并在客户端补齐两点：
 * - 不支持 DSD 的宿主环境（如旧浏览器、jsdom）用脚本接管模板内容；
 * - 接管后登记已有样式，避免 hydration 时重复注入静态样式。
 */
import {
  registerAppliedStyleTexts,
  resolveStaticStyleText,
  type StaticStyles,
} from '../component/styles';
import { ssrSerializeAttribute } from './ssr';

export type DeclarativeShadowRootMode = 'open' | 'closed';

export interface DeclarativeShadowRootOptions {
  /** shadow root 模式，默认 `open`。 */
  mode?: DeclarativeShadowRootMode;
  /** 需要内联进 shadow root 的静态样式，避免首屏无样式。 */
  styles?: StaticStyles;
  /** 是否输出 `shadowrootdelegatesfocus`，用于表单/焦点代理场景。 */
  delegatesFocus?: boolean;
}

export interface DeclarativeShadowComponentOptions extends DeclarativeShadowRootOptions {
  /** 自定义元素标签名，例如 `my-card`。 */
  tagName: string;
  /** 宿主元素属性；字符串会原样写入，对象按键值序列化。 */
  attributes?: Record<string, unknown> | string;
  /** 宿主 light DOM 内容（例如要投影进 `<slot>` 的子节点）。 */
  lightDom?: string;
  /**
   * 覆盖组件的渲染根模式。
   *
   * 未指定时读取 `component.renderMode`（编译产物会保留 `Comp.renderMode = 'light'`）。
   * `light` 模式输出普通 HTML —— 再包 DSD 模板会让 SSR 内容被藏进没人使用的 shadow root。
   */
  renderMode?: 'shadow' | 'light';
  /** light 模式下是否把静态样式内联进宿主，默认 `true`。 */
  inlineStyles?: boolean;
}

export interface DeclarativeShadowComponentLike {
  render?: (props?: Record<string, unknown>) => string;
  renderStream?: (
    props?: Record<string, unknown>
  ) => AsyncGenerator<string, void, void>;
  styles?: StaticStyles;
  /** 组件声明的渲染根；编译产物会保留 `Comp.renderMode = 'light'` 这类赋值。 */
  renderMode?: 'shadow' | 'light';
}

/** 只允许标签名里出现的字符，防止 SSR 模板被拼坏。 */
const normalizeTagName = (tagName: string): string => {
  const normalized = tagName.trim().toLowerCase();

  if (!/^[a-z][a-z0-9-]*$/.test(normalized)) {
    throw new TypeError(
      `Declarative Shadow DOM rendering received an invalid tag name: "${tagName}".`
    );
  }

  return normalized;
};

const renderShadowRootAttributes = (
  options: DeclarativeShadowRootOptions
): string => {
  const mode = options.mode ?? 'open';
  let attributes = ` shadowrootmode="${mode}"`;

  if (options.delegatesFocus) {
    attributes += ' shadowrootdelegatesfocus';
  }

  return attributes;
};

const renderStyles = (styles: StaticStyles | undefined): string => {
  const cssText = resolveStaticStyleText(styles);

  if (cssText.length === 0) {
    return '';
  }

  // SSR 阶段没有构造式样式表，只能内联 `<style>`；客户端会登记这段文本避免重复注入。
  // CSS 不能做 HTML 转义（会破坏 `>` 选择器），只需处理会提前关闭标签的 `</style`。
  return `<style data-lania-ssr-style>${cssText.replace(
    /<\/style/gi,
    '<\\/style'
  )}</style>`;
};

const renderAttributes = (
  attributes: Record<string, unknown> | string | undefined
): string => {
  if (attributes == null) {
    return '';
  }

  if (typeof attributes === 'string') {
    const trimmed = attributes.trim();
    return trimmed.length === 0 ? '' : ` ${trimmed}`;
  }

  return Object.entries(attributes)
    .map(([name, value]) => ssrSerializeAttribute(name, value))
    .join('');
};

/**
 * 把组件 HTML 包成 `<template shadowrootmode>`。
 *
 * 该字符串可以直接嵌进宿主自定义元素的打开标签之后，浏览器解析时即创建 shadow root。
 */
export const renderDeclarativeShadowRoot = (
  html: string,
  options: DeclarativeShadowRootOptions = {}
): string => {
  return `<template${renderShadowRootAttributes(options)}>${renderStyles(
    options.styles
  )}${html}</template>`;
};

/** 输出完整的自定义元素字符串：宿主属性 + DSD 模板 + light DOM。 */
export const renderDeclarativeShadowComponent = (
  html: string,
  options: DeclarativeShadowComponentOptions
): string => {
  const tagName = normalizeTagName(options.tagName);
  const attributes = renderAttributes(options.attributes);
  const lightDom = options.lightDom ?? '';

  return `<${tagName}${attributes}>${renderDeclarativeShadowRoot(
    html,
    options
  )}${lightDom}</${tagName}>`;
};

/** 输出 light DOM 形态的宿主（不创建 shadow root）。 */
export const renderLightComponent = (
  html: string,
  options: DeclarativeShadowComponentOptions
): string => {
  const tagName = normalizeTagName(options.tagName);
  const attributes = renderAttributes(options.attributes);
  // light 模式下样式与内容同处文档树，样式天然是全局作用域。
  const inlineStyles =
    options.inlineStyles === false ? '' : renderStyles(options.styles);

  return `<${tagName}${attributes}>${inlineStyles}${html}${
    options.lightDom ?? ''
  }</${tagName}>`;
};

/**
 * 按组件声明的渲染根输出完整元素。
 *
 * - `shadow`（默认）：`<tag><template shadowrootmode>styles+html</template></tag>`
 * - `light`：`<tag>styles?+html</tag>`
 *
 * 这是 SSR 的推荐入口：调用方不需要自己判断组件用的是哪种渲染根。
 */
export const renderComponentToString = (
  component: DeclarativeShadowComponentLike,
  props: Record<string, unknown>,
  options: DeclarativeShadowComponentOptions
): string => {
  if (typeof component.render !== 'function') {
    throw new TypeError(
      'renderComponentToString() expects a compiled component with a static render() method.'
    );
  }

  const html = component.render(props);
  const styles = options.styles ?? component.styles;
  const renderMode = options.renderMode ?? component.renderMode ?? 'shadow';

  if (renderMode === 'light') {
    return renderLightComponent(html, { ...options, styles });
  }

  return renderDeclarativeShadowComponent(html, {
    ...options,
    styles,
  });
};

/**
 * 调用编译产物的 `static render()` 并输出带 DSD 的完整元素。
 *
 * `styles` 默认取组件类上的静态样式，保证服务端首屏与客户端 hydration 样式一致。
 * `renderMode = 'light'` 的组件会退化成普通 HTML 输出。
 */
export const renderToStringWithDeclarativeShadow = (
  component: DeclarativeShadowComponentLike,
  props: Record<string, unknown>,
  options: DeclarativeShadowComponentOptions
): string => renderComponentToString(component, props, options);

/**
 * 按渲染根输出流式结果。
 *
 * `light` 模式下不需要闭合 shadow 模板，因此只在首块写宿主开标签与样式。
 */
export async function* renderComponentToStream(
  component: DeclarativeShadowComponentLike,
  props: Record<string, unknown>,
  options: DeclarativeShadowComponentOptions
): AsyncGenerator<string, void, void> {
  const renderMode = options.renderMode ?? component.renderMode ?? 'shadow';

  if (renderMode === 'light') {
    for await (const chunk of renderComponentLightStream(
      component,
      props,
      options
    )) {
      yield chunk;
    }
    return;
  }

  yield* renderStreamToDeclarativeShadow(component, props, options);
}

async function* renderComponentLightStream(
  component: DeclarativeShadowComponentLike,
  props: Record<string, unknown>,
  options: DeclarativeShadowComponentOptions
): AsyncGenerator<string, void, void> {
  if (typeof component.renderStream !== 'function') {
    throw new TypeError(
      'renderComponentToStream() expects a compiled component with a static renderStream() method.'
    );
  }

  const tagName = normalizeTagName(options.tagName);
  const attributes = renderAttributes(options.attributes);
  const styles = options.styles ?? component.styles;

  yield `<${tagName}${attributes}>${
    options.inlineStyles === false ? '' : renderStyles(styles)
  }`;

  for await (const chunk of component.renderStream(props)) {
    yield chunk;
  }

  yield `${options.lightDom ?? ''}</${tagName}>`;
}

/**
 * 流式版本：先输出宿主与 shadow root 开头，再逐块写内容，最后收尾。
 *
 * 首块就包含内联样式，避免流式渲染时先看到无样式内容。
 */
export async function* renderStreamToDeclarativeShadow(
  component: DeclarativeShadowComponentLike,
  props: Record<string, unknown>,
  options: DeclarativeShadowComponentOptions
): AsyncGenerator<string, void, void> {
  if (typeof component.renderStream !== 'function') {
    throw new TypeError(
      'renderStreamToDeclarativeShadow() expects a compiled component with a static renderStream() method.'
    );
  }

  const tagName = normalizeTagName(options.tagName);
  const attributes = renderAttributes(options.attributes);
  const styles = options.styles ?? component.styles;

  yield `<${tagName}${attributes}><template${renderShadowRootAttributes(
    options
  )}>${renderStyles(styles)}`;

  for await (const chunk of component.renderStream(props)) {
    yield chunk;
  }

  yield `</template>${options.lightDom ?? ''}</${tagName}>`;
}

/** 读取宿主元素里尚未被平台消费的 DSD 模板。 */
export const readDeclarativeShadowTemplate = (
  element: Element
): HTMLTemplateElement | null => {
  const template = Array.from(element.children).find(
    (child): child is HTMLTemplateElement =>
      child instanceof HTMLTemplateElement &&
      child.hasAttribute('shadowrootmode')
  );

  return template ?? null;
};

/**
 * 让宿主元素拥有一份与 SSR 输出一致的 shadow root。
 *
 * - 平台已原生支持 DSD 时，`element.shadowRoot` 已存在，直接复用；
 * - 否则手动 `attachShadow()` 并把模板内容搬进去，同时移除模板节点；
 * - 两者都会登记已有样式，供后续 `adoptStyles()` 去重。
 */
export const attachDeclarativeShadowRoot = (
  element: HTMLElement,
  options: DeclarativeShadowRootOptions = {}
): ShadowRoot | null => {
  if (element.shadowRoot) {
    registerAppliedStyleTexts(element.shadowRoot);
    return element.shadowRoot;
  }

  const template = readDeclarativeShadowTemplate(element);

  if (!template) {
    return null;
  }

  const mode =
    (template.getAttribute(
      'shadowrootmode'
    ) as DeclarativeShadowRootMode | null) ??
    options.mode ??
    'open';
  const root = element.attachShadow({
    mode,
    delegatesFocus:
      template.hasAttribute('shadowrootdelegatesfocus') ||
      Boolean(options.delegatesFocus),
  } as ShadowRootInit);

  root.appendChild(template.content.cloneNode(true));
  template.remove();
  registerAppliedStyleTexts(root);

  return root;
};
