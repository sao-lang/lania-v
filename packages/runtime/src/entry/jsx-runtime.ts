/**
 * JSX 运行时入口与类型声明。
 *
 * 该文件同时承担两层职责：
 * - 类型层：导出 JSX namespace、内建元素 props 与增强组件 props，供 TS/编辑器推断；
 * - 运行时层：实现 `jsx/jsxs/jsxDEV`，把 JSX 调用直接转换成原生 DOM、组件元素或增强组件结果。
 * - 协议层：约定 `children / class / style / html / model / use / onXxx` 这类 JSX 属性在运行时的落点。
 *
 * 整体设计延续“直接返回可渲染值”的运行时模型，不引入额外 VNode 中间层，
 * 因此这里既像类型入口，也像一个精简版的 DOM/组件工厂。
 *
 * 读这个文件时可以按三段理解：
 * - 前半段是 JSX 类型面，决定编辑器如何理解标签与 props；
 * - 中间一段是 DOM 属性写入策略，决定 JSX props 如何映射到真实节点；
 * - 末尾的 `jsx()` 分发负责把“原生标签 / 编译产物组件 / 普通函数组件”送进各自路径。
 */
import { DOM_EVENT_NAMES, withEventModifiers } from '../component/events';
import type { EventModifier } from '../component/events';
import {
  attachFunctionComponentBindingMetadata,
  createComponentElement,
  isComponentElementConstructor,
  registerFunctionComponentRenderResult,
  withRuntimeScope,
} from '../component/host/function-component';
import {
  Fragment as RuntimeFragment,
  type EnhancedRenderable,
  type CaseProps,
  type DefaultProps,
  type DynamicProps,
  type EachProps,
  type ElseProps,
  type ErrorBoundaryProps,
  type FragmentProps,
  type KeepAliveProps,
  type LazyLoadProps,
  type SuspenseProps,
  type SwitchProps,
  type TeleportProps,
  type ThenProps,
  type TransitionGroupProps,
  type TransitionProps,
  type WhenProps,
} from '../component/enhanced-components';
import type { ClassValue } from '../dom/class-value';
import { writeClassAttribute } from '../dom/class-value';
import {
  createModelEventHandler,
  type DirectiveDef,
  type ModelBinding,
} from '../dom/directives';
import { applyHtml, type HtmlBindingValue } from '../dom/html-value';
import { setRef, type RefBinding } from '../dom/ref';
import { writeStyleAttribute, type StyleBindingValue } from '../dom/style-value';

// 对编辑器 hover 与 JSX namespace 来说，JSX 返回值类型统一暴露为“可直接渲染值”。
// 这里刻意不引入专门的 VNode 类型，避免类型层与运行时模型出现两套概念。
export type LaniaJsxElement = EnhancedRenderable;
export type JsxElement = LaniaJsxElement;

type JsxChild = JsxElement | readonly JsxElement[];

type WritableSignalLike<T = unknown> = (() => T) & {
  set(value: T | ((previous: T) => T)): unknown;
};

// JSX 事件既支持直接传函数，也支持携带 modifiers/listener 选项的对象写法。
type EventBindingObject<TEvent extends Event = Event> = {
  handler: (event: TEvent) => unknown;
  modifiers?:
    | readonly EventModifier[]
    | Readonly<Record<string, boolean | undefined>>;
  listener?: {
    once?: boolean;
    capture?: boolean;
    passive?: boolean;
  };
};

type EventBindingValue<TEvent extends Event = Event> =
  | ((event: TEvent) => unknown)
  | EventBindingObject<TEvent>;

type PrimitiveAttributeValue = string | number | boolean | null | undefined;
type InputTypeAttribute =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'radio'
  | 'email'
  | 'password'
  | 'search'
  | 'url'
  | 'tel'
  | 'hidden'
  | 'date'
  | 'datetime-local'
  | 'month'
  | 'time'
  | 'week'
  | 'file'
  | 'range'
  | 'color'
  | 'submit'
  | 'reset'
  | 'button'
  | (string & {});

// 常见原生元素共享这一层 props，再由具体标签追加更精细的约束。
type CommonDomProps<TElement extends Element = HTMLElement> = {
  id?: string;
  title?: string;
  role?: string;
  slot?: string;
  part?: string;
  hidden?: boolean;
  inert?: boolean;
  tabIndex?: number;
  dir?: string;
  lang?: string;
  draggable?: boolean;
  spellCheck?: boolean;
  spellcheck?: boolean;
  contentEditable?: boolean | 'true' | 'false' | 'inherit';
  accessKey?: string;
  inputMode?: string;
  type?: string;
  name?: string;
  value?: unknown;
  checked?: boolean;
  disabled?: boolean;
  placeholder?: string;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  href?: string;
  target?: string;
  rel?: string;
  src?: string;
  alt?: string;
  width?: string | number;
  height?: string | number;
  htmlFor?: string;
  for?: string;
  autoComplete?: string;
  autocomplete?: string;
  readOnly?: boolean;
  readonly?: boolean;
  selected?: boolean;
  multiple?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  autofocus?: boolean;
  controls?: boolean;
  autoplay?: boolean;
  loop?: boolean;
  muted?: boolean;
  poster?: string;
  preload?: string;
  srcSet?: string;
  crossOrigin?: 'anonymous' | 'use-credentials' | (string & {});
  referrerPolicy?: string;
  download?: PrimitiveAttributeValue;
  [attributeName: `data-${string}`]: PrimitiveAttributeValue;
  [attributeName: `aria-${string}`]: PrimitiveAttributeValue;
  ref?: RefBinding<TElement>;
};

type LaniaDirectiveProps = {
  children?: JsxChild;
  key?: string | number;
  class?: ClassValue;
  className?: ClassValue;
  style?: StyleBindingValue;
  html?: HtmlBindingValue;
  model?: ModelBinding<unknown> | WritableSignalLike<unknown>;
  use?: Readonly<Record<string, unknown | DirectiveDef<unknown>>>;
};

export type LaniaEventProps = {
  onClick?: EventBindingValue<MouseEvent>;
  onInput?: EventBindingValue<Event>;
  onChange?: EventBindingValue<Event>;
  onKeyDown?: EventBindingValue<KeyboardEvent>;
  onKeyUp?: EventBindingValue<KeyboardEvent>;
  onKeyPress?: EventBindingValue<KeyboardEvent>;
  onSubmit?: EventBindingValue<SubmitEvent>;
  onFocus?: EventBindingValue<FocusEvent>;
  onBlur?: EventBindingValue<FocusEvent>;
  onPointerDown?: EventBindingValue<PointerEvent>;
  onPointerUp?: EventBindingValue<PointerEvent>;
  [eventName: `on${string}`]: EventBindingValue<any> | undefined;
};

export type LaniaIntrinsicElementProps<TElement extends Element = HTMLElement> =
  CommonDomProps<TElement> &
  LaniaDirectiveProps &
  LaniaEventProps;

export interface LaniaCommonIntrinsicElements {
  div: LaniaIntrinsicElementProps<HTMLDivElement>;
  span: LaniaIntrinsicElementProps<HTMLSpanElement>;
  p: LaniaIntrinsicElementProps<HTMLParagraphElement>;
  section: LaniaIntrinsicElementProps<HTMLElement>;
  article: LaniaIntrinsicElementProps<HTMLElement>;
  header: LaniaIntrinsicElementProps<HTMLElement>;
  footer: LaniaIntrinsicElementProps<HTMLElement>;
  main: LaniaIntrinsicElementProps<HTMLElement>;
  aside: LaniaIntrinsicElementProps<HTMLElement>;
  nav: LaniaIntrinsicElementProps<HTMLElement>;
  label: LaniaIntrinsicElementProps<HTMLLabelElement> & {
    htmlFor?: string;
    for?: string;
  };
  form: LaniaIntrinsicElementProps<HTMLFormElement> & {
    action?: string;
    method?: 'get' | 'post' | 'dialog' | (string & {});
    encType?: string;
    enctype?: string;
    noValidate?: boolean;
  };
  button: LaniaIntrinsicElementProps<HTMLButtonElement> & {
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    name?: string;
    value?: string | number;
  };
  input: LaniaIntrinsicElementProps<HTMLInputElement> & {
    type?: InputTypeAttribute;
    value?: string | number | readonly string[];
    checked?: boolean;
    disabled?: boolean;
    placeholder?: string;
    min?: string | number;
    max?: string | number;
    step?: string | number;
    accept?: string;
    capture?: boolean | 'user' | 'environment';
    pattern?: string;
    minLength?: number;
    minlength?: number;
    maxLength?: number;
    maxlength?: number;
    readOnly?: boolean;
    readonly?: boolean;
    required?: boolean;
  };
  textarea: LaniaIntrinsicElementProps<HTMLTextAreaElement> & {
    value?: string;
    placeholder?: string;
    rows?: number;
    cols?: number;
    disabled?: boolean;
    readOnly?: boolean;
    readonly?: boolean;
    required?: boolean;
    minLength?: number;
    minlength?: number;
    maxLength?: number;
    maxlength?: number;
    wrap?: 'hard' | 'soft' | 'off' | (string & {});
  };
  select: LaniaIntrinsicElementProps<HTMLSelectElement> & {
    value?: string | number | readonly string[];
    disabled?: boolean;
    multiple?: boolean;
    required?: boolean;
    size?: number;
  };
  option: LaniaIntrinsicElementProps<HTMLOptionElement> & {
    value?: string | number;
    label?: string;
    selected?: boolean;
    disabled?: boolean;
  };
  a: LaniaIntrinsicElementProps<HTMLAnchorElement> & {
    href?: string;
    target?: string;
    rel?: string;
    download?: PrimitiveAttributeValue;
    hreflang?: string;
    referrerPolicy?: string;
  };
  img: LaniaIntrinsicElementProps<HTMLImageElement> & {
    src?: string;
    srcSet?: string;
    alt?: string;
    width?: string | number;
    height?: string | number;
    loading?: 'eager' | 'lazy' | (string & {});
    decoding?: 'sync' | 'async' | 'auto';
    crossOrigin?: 'anonymous' | 'use-credentials' | (string & {});
    referrerPolicy?: string;
  };
  ul: LaniaIntrinsicElementProps<HTMLUListElement>;
  ol: LaniaIntrinsicElementProps<HTMLOListElement> & {
    start?: number;
    reversed?: boolean;
    type?: '1' | 'a' | 'A' | 'i' | 'I' | (string & {});
  };
  li: LaniaIntrinsicElementProps<HTMLLIElement> & {
    value?: string | number;
  };
  table: LaniaIntrinsicElementProps<HTMLTableElement> & {
    cellPadding?: string | number;
    cellSpacing?: string | number;
  };
  thead: LaniaIntrinsicElementProps<HTMLTableSectionElement>;
  tbody: LaniaIntrinsicElementProps<HTMLTableSectionElement>;
  tfoot: LaniaIntrinsicElementProps<HTMLTableSectionElement>;
  tr: LaniaIntrinsicElementProps<HTMLTableRowElement>;
  td: LaniaIntrinsicElementProps<HTMLTableCellElement> & {
    colSpan?: number;
    rowSpan?: number;
    headers?: string;
  };
  th: LaniaIntrinsicElementProps<HTMLTableCellElement> & {
    colSpan?: number;
    rowSpan?: number;
    headers?: string;
    scope?: 'col' | 'row' | 'colgroup' | 'rowgroup' | (string & {});
    abbr?: string;
  };
  caption: LaniaIntrinsicElementProps<HTMLElement>;
  colgroup: LaniaIntrinsicElementProps<HTMLTableColElement> & {
    span?: number;
  };
  col: LaniaIntrinsicElementProps<HTMLTableColElement> & {
    span?: number;
  };
  video: LaniaIntrinsicElementProps<HTMLVideoElement> & {
    src?: string;
    controls?: boolean;
    autoplay?: boolean;
    loop?: boolean;
    muted?: boolean;
    poster?: string;
    preload?: string;
    playsinline?: boolean;
    playsInline?: boolean;
    width?: string | number;
    height?: string | number;
    crossOrigin?: 'anonymous' | 'use-credentials' | (string & {});
  };
  audio: LaniaIntrinsicElementProps<HTMLAudioElement> & {
    src?: string;
    controls?: boolean;
    autoplay?: boolean;
    loop?: boolean;
    muted?: boolean;
    preload?: string;
    crossOrigin?: 'anonymous' | 'use-credentials' | (string & {});
  };
  source: LaniaIntrinsicElementProps<HTMLSourceElement> & {
    src?: string;
    srcSet?: string;
    srcset?: string;
    sizes?: string;
    type?: string;
    media?: string;
  };
  track: LaniaIntrinsicElementProps<HTMLTrackElement> & {
    default?: boolean;
    kind?: 'subtitles' | 'captions' | 'descriptions' | 'chapters' | 'metadata' | (string & {});
    src?: string;
    srclang?: string;
    label?: string;
  };
  details: LaniaIntrinsicElementProps<HTMLDetailsElement> & {
    open?: boolean;
  };
  summary: LaniaIntrinsicElementProps<HTMLElement>;
  canvas: LaniaIntrinsicElementProps<HTMLCanvasElement> & {
    width?: string | number;
    height?: string | number;
  };
  iframe: LaniaIntrinsicElementProps<HTMLIFrameElement> & {
    src?: string;
    name?: string;
    width?: string | number;
    height?: string | number;
    allow?: string;
    allowfullscreen?: boolean;
    allowFullScreen?: boolean;
    loading?: 'eager' | 'lazy' | (string & {});
    referrerPolicy?: string;
    sandbox?: string;
  };
  progress: LaniaIntrinsicElementProps<HTMLProgressElement> & {
    value?: number;
    max?: number;
  };
  meter: LaniaIntrinsicElementProps<HTMLMeterElement> & {
    value?: number;
    min?: number;
    max?: number;
    low?: number;
    high?: number;
    optimum?: number;
  };
  dialog: LaniaIntrinsicElementProps<HTMLDialogElement> & {
    open?: boolean;
  };
  h1: LaniaIntrinsicElementProps<HTMLHeadingElement>;
  h2: LaniaIntrinsicElementProps<HTMLHeadingElement>;
  h3: LaniaIntrinsicElementProps<HTMLHeadingElement>;
  h4: LaniaIntrinsicElementProps<HTMLHeadingElement>;
  h5: LaniaIntrinsicElementProps<HTMLHeadingElement>;
  h6: LaniaIntrinsicElementProps<HTMLHeadingElement>;
}

type EnhancedIntrinsicElements = {
  // 这一组标签名不会直接创建原生 DOM，而是交给增强组件运行时解释其语义。
  When: WhenProps;
  Then: ThenProps;
  Else: ElseProps;
  Switch: SwitchProps;
  Case: CaseProps;
  Default: DefaultProps;
  Each: EachProps<any>;
  Teleport: TeleportProps;
  Fragment: FragmentProps;
  Dynamic: DynamicProps;
  KeepAlive: KeepAliveProps;
  Transition: TransitionProps;
  TransitionGroup: TransitionGroupProps;
  LazyLoad: LazyLoadProps;
  ErrorBoundary: ErrorBoundaryProps;
  Suspense: SuspenseProps;
};

type GenericNativeIntrinsicElements = {
  [TagName in keyof HTMLElementTagNameMap]: LaniaIntrinsicElementProps<
    HTMLElementTagNameMap[TagName]
  >;
} & {
  [TagName in keyof SVGElementTagNameMap]: LaniaIntrinsicElementProps<
    SVGElementTagNameMap[TagName]
  >;
};

type NativeIntrinsicElements = Omit<
  GenericNativeIntrinsicElements,
  keyof LaniaCommonIntrinsicElements
> &
  LaniaCommonIntrinsicElements;

export type LaniaNativeIntrinsicElements = NativeIntrinsicElements;
export type LaniaEnhancedIntrinsicElements = EnhancedIntrinsicElements;

export type JsxProps = Record<string, unknown> & {
  children?: JsxChild;
  key?: string | number;
};

// JSX namespace 主要服务于 TS 编译器与编辑器提示，本身不会参与运行时逻辑。
export namespace JSX {
  export type Element = LaniaJsxElement;

  export interface ElementChildrenAttribute {
    // 告诉 TS `children` 是 JSX children 的默认承载字段。
    children: {};
  }

  export interface IntrinsicAttributes {
    key?: string | number;
  }

  export type IntrinsicElements = NativeIntrinsicElements &
    EnhancedIntrinsicElements & {
      [elementName: string]:
        | LaniaIntrinsicElementProps<HTMLElement>
        | EnhancedIntrinsicElements[keyof EnhancedIntrinsicElements];
    };

  export type LibraryManagedAttributes<C, P> = [C] extends [never] ? P : P;
}

const appendChild = (parent: Node, value: JsxChild): void => {
  if (value == null || value === false) {
    return;
  }

  if (Array.isArray(value)) {
    // JSX children 允许深层数组，这里递归拍平并按原顺序追加。
    value.forEach((entry) => appendChild(parent, entry));
    return;
  }

  if (typeof value === 'function') {
    // 兼容“函数即 renderable”的约定，运行时取值后继续走统一 child 追加逻辑。
    appendChild(parent, value());
    return;
  }

  if (value instanceof Node) {
    // 运行时允许 JSX 直接返回原生 Node，这里原样挂入父节点。
    parent.appendChild(value);
    return;
  }

  parent.appendChild(document.createTextNode(String(value)));
};

const writeProperty = (
  element: Element,
  name: string,
  value: unknown
): void => {
  const record = element as unknown as Record<string, unknown>;

  if (name in record) {
    // DOM 原生属性优先走 property 赋值，保留布尔值、对象值等语义。
    record[name] = value;
    return;
  }

  if (value == null || value === false) {
    element.removeAttribute(name);
    return;
  }

  element.setAttribute(name, String(value));
};

const applyProp = (element: Element, name: string, value: unknown): void => {
  if (name === 'children' || name === 'key') {
    // `children` 统一在属性写入结束后追加，`key` 只参与上层调度或调试标记。
    return;
  }

  if (name === 'class' || name === 'className') {
    writeClassAttribute(element, value);
    return;
  }

  if (name === 'style') {
    // 样式对象、数组、字符串的归一化逻辑都下沉到 style writer 中复用。
    writeStyleAttribute(element, value);
    return;
  }

  if (name === 'html') {
    // `html` 直接接管 innerHTML，与 children 互斥，调用方通过下方分支避免重复追加。
    applyHtml(element as HTMLElement, value);
    return;
  }

  if (name === 'ref') {
    setRef(value as RefBinding<Element>, element);
    return;
  }

  if (name.startsWith('class:')) {
    // `class:foo={expr}` 映射成 classList toggle，保持模板指令与 JSX 属性写法一致。
    const className = name.slice('class:'.length);
    if (value) {
      element.classList.add(className);
    } else {
      element.classList.remove(className);
    }
    return;
  }

  if (name.startsWith('style:')) {
    // `style:color={x}` 走 CSS 自定义属性式的逐项写入，避免覆盖整段 style。
    const styleName = name.slice('style:'.length);
    const styleTarget = element as HTMLElement;
    if (value == null || value === false) {
      styleTarget.style.removeProperty(styleName);
    } else {
      styleTarget.style.setProperty(styleName, String(value));
    }
    return;
  }

  if (name.startsWith('model:')) {
    const prop = name.slice('model:'.length) || 'value';
    if (value && typeof value === 'function' && 'set' in value) {
      // signal 风格 model 既要回填初值，也要自动注册输入事件完成双向同步。
      const signal = value as { (): unknown; set(next: unknown): unknown };
      writeProperty(element, prop, signal());
      element.addEventListener(
        prop === 'checked' ? 'change' : 'input',
        createModelEventHandler(signal, [], prop)
      );
    } else {
      writeProperty(element, prop, value);
    }
    return;
  }

  if (name.startsWith('bind:')) {
    // `bind:` 只做单向 property 回填，不像 `model:` 那样自动建立事件回写。
    const prop = name.slice('bind:'.length) || 'value';
    writeProperty(element, prop, value);
    return;
  }

  if (name.startsWith('use:')) {
    if (
      value &&
      typeof value === 'object' &&
      typeof (value as { mounted?: unknown }).mounted === 'function'
    ) {
      // 轻量指令协议只在创建阶段执行 mounted，保持 JSX 直出路径尽量简单。
      (value as { mounted(el: HTMLElement, next: unknown): void }).mounted(
        element as HTMLElement,
        value
      );
    }
    return;
  }

  if (/^on[A-Z]/.test(name) && typeof value === 'function') {
    // `onClick` 这类 JSX 事件名按 React 风格映射到小写 DOM 事件。
    const eventName = name.slice(2);
    const domEventName = eventName.toLowerCase();
    element.addEventListener(
      domEventName,
      withEventModifiers(value as (event: Event) => void, [])!
    );
    return;
  }

  if (DOM_EVENT_NAMES.has(name) && typeof value === 'function') {
    // 已是原生事件名时直接监听，兼容 `click` / `input` 一类写法。
    element.addEventListener(
      name,
      withEventModifiers(value as (event: Event) => void, [])!
    );
    return;
  }

  writeProperty(element, name, value);
};

const createIntrinsicElement = (
  type: string,
  props: JsxProps,
  key: string | number | undefined
): Element => {
  const element = document.createElement(type);

  if (key !== undefined) {
    // key 在直出 DOM 路径下仅保留为调试/后续运行时读取用的数据属性。
    element.setAttribute('data-key', String(key));
  }

  Object.entries(props).forEach(([name, value]) => {
    // 所有属性都先走统一的 `applyProp()`，保证 DOM 直出路径与模板/指令语义尽量一致。
    applyProp(element, name, value);
  });
  if (!('html' in props)) {
    // 只有没声明 `html` 时才追加 children，避免 `innerHTML + children` 双写同一节点内容。
    appendChild(element, props.children ?? null);
  }
  return element;
};

export const Fragment = RuntimeFragment;

export const jsx = (
  type: string | ((props: JsxProps) => JsxElement),
  props: JsxProps | null,
  key?: string
): JsxElement => {
  // 编译产物可能传入 null props，这里统一归一成对象，减少后续分支噪音。
  const nextProps = props ?? {};

  if (type === RuntimeFragment) {
    // Fragment 本身不产生宿主节点，只透传 children。
    return nextProps.children ?? null;
  }

  if (typeof type === 'string') {
    // 原生标签路径最直接：立即创建 DOM、写属性、追加 children，然后把结果交给上层。
    return createIntrinsicElement(type, nextProps, key);
  }

  if (isComponentElementConstructor(type)) {
    // 编译产物组件与手写函数组件不同，它们有自己的宿主协议和生命周期控制器，
    // 因此这里不能直接 `type(props)`，而要交给组件宿主工厂创建元素实例。
    return createComponentElement(type, {
      props: {
        ...nextProps,
        key,
      },
    });
  }

  // 普通函数组件通过 runtime scope 注入 slotContent 等上下文，
  // 让函数组件也能与编译产物中的 slot/children 协议对齐。
  const functionProps = attachFunctionComponentBindingMetadata(
    {
      ...nextProps,
      key,
    },
    {
      // JSX 入口先把 handler keys 显式标出来，后续 `bindProps()` /
      // `bindHandlers()` 就不必每次都重新猜一遍。
      handlerKeys: Object.keys(nextProps).filter((name) => /^on[A-Z]/.test(name)),
    }
  );
  const cleanups = new Set<() => void>();
  const result = withRuntimeScope(
    {
      slotContent: functionProps.children,
      functionComponentCleanups: cleanups,
    },
    () => type(functionProps)
  );
  registerFunctionComponentRenderResult(result, cleanups);
  return result;
};

export const jsxs = jsx;

export const jsxDEV = jsx;
