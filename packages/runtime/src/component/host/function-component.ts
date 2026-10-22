/**
 * 函数组件与轻量“运行时辅助”。
 *
 * - `createRoot`：把函数组件/增强组件的产物挂载到容器中（非常轻量，不做 diff）；
 * - `useContext/withContextHost`：让函数组件可以使用同一套 Context 机制；
 * - `lazy`：懒加载函数组件（未加载时会 throw Promise，供 Suspense 捕获）。
 *
 * 这里不是完整组件运行时，而是一组面向“函数组件结果值”的辅助工具：
 * 它负责上下文透传、自定义元素注册、轻量 root 挂载，以及少量编译期专用 API 占位。
 * 也因此它刻意不维护组件实例树、调度器或 diff，只提供“编译产物需要的最小宿主能力”。
 */
import { consumeContext, type Context } from '../../core/context';
import { isDevEnvironment } from '../../core/debug';
import {
  applyComponentHmrUpdate,
  isComponentHmrEnabled,
  type HmrComponentConstructor,
} from '../../dev/hmr';
import type { StaticStyles } from '../styles';
import type { PropOptionsMap } from './prop-options';
import type { ReadonlySignal } from '@lania-v/reactivity';
import type { ChangedProps } from './reactive-element';
import { appendRenderable, collectRenderableNodes } from '../renderable';
import { markRefExposed, setRef, type RefBinding } from '../../dom/ref';

export type FunctionComponent<
  Props = Record<string, unknown>,
  Result = unknown,
> = (props: Props) => Result;

export type DefinedComponent<
  Props = Record<string, unknown>,
  Result = unknown,
  TElement extends HTMLElement = HTMLElement,
> = FunctionComponent<Props, Result> & ComponentElementConstructor<TElement>;

export interface ComponentElementConstructor<
  TElement extends HTMLElement = HTMLElement,
> extends CustomElementConstructor {
  new (): TElement;
  tagName?: string;
  displayName?: string;
  styles?: StaticStyles;
  /** 编译期声明的 `onXxx` prop 名，供 bindHandlers 在值尚未传入时也能正确分流。 */
  handlerKeys?: readonly string[];
  /** 编译期声明的 prop 选项（attribute / reflect / converter / validator）。 */
  propOptions?: import('./prop-options').PropOptionsMap;
  /** 编译期声明的事件名单，用于 emit 校验。 */
  emits?: readonly string[];
}

export interface EnsureCustomElementOptions {
  tagName?: string;
  styles?: StaticStyles;
}

export interface CreateComponentElementOptions extends EnsureCustomElementOptions {
  props?: Record<string, unknown>;
}

export type LazyResolvedModule<T extends FunctionComponent<any, any>> =
  | T
  | {
      default: T;
    };

export type LazyComponent<T extends FunctionComponent<any, any>> = T & {
  preload(): Promise<T>;
  resolved(): T | null;
};

export interface Root {
  render(content: unknown): void;
  unmount(): void;
}

export type DomHostTarget = {
  parent: Node;
  anchor: Node;
  owner?: DomHostOwner;
};

export type DomHostBlockRecord = {
  key: unknown;
  parent: Node;
  start: Comment;
  end: Comment;
  getElements(): HTMLElement[];
  moveBefore(referenceNode: Node | null): void;
  finalizeRemoval(): void;
  destroyBindings: () => void;
};

export type DomHostRemovedBlockHandoff = {
  key: unknown;
  previousIndex: number;
  block: DomHostBlockRecord;
};

export type DomHostOwner = {
  registerActiveBlock?(block: DomHostBlockRecord): void;
  handoffRemovedBlock?(handoff: DomHostRemovedBlockHandoff): boolean;
};

export const DOM_HOST_SYMBOL = Symbol.for('lania.dom-host');

export interface RuntimeScopeHost {
  dispatchEvent(event: Event): boolean;
}

export interface RuntimeScope {
  host?: RuntimeScopeHost;
  domHost?: DomHostTarget;
  slotContent?: unknown;
  functionComponentCleanups?: Set<() => void>;
}

type FunctionComponentCleanup = () => void;

type HandlerBindingValue =
  | ((...args: any[]) => unknown)
  | {
      handler: (...args: any[]) => unknown;
    };

type HandlerKeyOf<T extends object> = Extract<
  {
    [K in keyof T]-?: K extends `on${string}`
      ? NonNullable<T[K]> extends HandlerBindingValue
        ? K
        : never
      : never;
  }[keyof T],
  keyof T
>;

export type BoundProps<T extends object> = Readonly<Omit<T, HandlerKeyOf<T>>>;
export type BoundHandlers<T extends object> = Readonly<
  Pick<T, HandlerKeyOf<T>>
>;

export interface SlotBindings {
  has(name?: string): boolean;
  get(name?: string): unknown;
  render(name: string, fallback?: unknown, ...args: unknown[]): unknown;
  renderDefault(fallback?: unknown, ...args: unknown[]): unknown;
}

type FunctionComponentBindingMetadata = {
  handlerKeys?: readonly string[];
};

type FunctionComponentBindingState = {
  handlerKeys: Set<string>;
  propsView?: object;
  handlersView?: object;
};

type ComponentPropsContext = {
  /** 构造期直接持有 props；实例快照生成后会原地替换。 */
  props?: object;
  /** 延迟读取：HMR 重跑 setup 时实例 props 会被整体重建。 */
  resolve?: () => object;
};

const FUNCTION_COMPONENT_BINDING_METADATA = Symbol(
  'lania.function-component.binding-metadata'
);
const functionComponentBindingStates = new WeakMap<
  object,
  FunctionComponentBindingState
>();

// `bindProps()` / `bindHandlers()` 无参调用时从这里取当前组件的 props。
// 函数组件由 JSX 入口在调用前入栈，编译产物由编译器补 `this.props`，
// 构造期与 HMR 重挂载也会各自提供一个上下文。
const componentPropsContextStack: ComponentPropsContext[] = [];

const readComponentPropsContext = (
  context: ComponentPropsContext
): object | null => {
  return (context.resolve ? context.resolve() : context.props) ?? null;
};

/**
 * 在指定 props 上下文中执行 `run()`。
 *
 * 传函数时按调用时刻取值，适合实例 props 可能被重建的场景（HMR）。
 */
export const withComponentProps = <T>(
  source: object | (() => object),
  run: () => T
): T => {
  const context: ComponentPropsContext =
    typeof source === 'function'
      ? { resolve: source as () => object }
      : { props: source };

  componentPropsContextStack.push(context);

  try {
    return run();
  } finally {
    componentPropsContextStack.pop();
  }
};

const getCurrentComponentProps = (): object | null => {
  const context =
    componentPropsContextStack[componentPropsContextStack.length - 1];
  return context ? readComponentPropsContext(context) : null;
};

const renderableCleanupRegistry = new WeakMap<
  Node,
  Set<FunctionComponentCleanup>
>();

// 以“原始 slot anchor 节点”为键记录重定向目标。
// 这样结构型 slot 仍可相对自己的 anchor 插入，而更高层宿主
// （例如 TransitionGroup）又能把写入重定向到稳定容器中，无需改编译产物。
const domHostRedirects = new WeakMap<Node, DomHostTarget>();

export const registerDomHostRedirect = (
  anchor: Node,
  target: DomHostTarget
): void => {
  domHostRedirects.set(anchor, target);
};

export const getDomHostRedirect = (anchor: Node): DomHostTarget | undefined => {
  return domHostRedirects.get(anchor);
};

let currentScope: RuntimeScope | undefined;

export const getCurrentRuntimeScope = (): RuntimeScope | undefined =>
  currentScope;
export const getCurrentDomHostTarget = (): DomHostTarget | undefined =>
  currentScope?.domHost;

const isHandlerBindingValue = (
  value: unknown
): value is HandlerBindingValue => {
  return (
    typeof value === 'function' ||
    (value !== null &&
      typeof value === 'object' &&
      typeof (value as { handler?: unknown }).handler === 'function')
  );
};

const inferHandlerKeysFromProps = (props: object): string[] => {
  return Object.keys(props).filter((key) => {
    return (
      /^on[A-Z]/.test(key) &&
      isHandlerBindingValue((props as Record<string, unknown>)[key])
    );
  });
};

const getFunctionComponentBindingMetadata = (
  props: object
): FunctionComponentBindingMetadata | undefined => {
  return (props as Record<PropertyKey, unknown>)[
    FUNCTION_COMPONENT_BINDING_METADATA
  ] as FunctionComponentBindingMetadata | undefined;
};

const createBindingView = (
  props: object,
  includeKey: (key: string) => boolean
): object => {
  const view = Object.create(null) as Record<string, unknown>;

  Object.keys(props).forEach((key) => {
    if (!includeKey(key)) {
      return;
    }

    Object.defineProperty(view, key, {
      enumerable: true,
      configurable: false,
      get() {
        return (props as Record<string, unknown>)[key];
      },
    });
  });

  return Object.freeze(view);
};

const getFunctionComponentBindingState = (
  props: object
): FunctionComponentBindingState => {
  const cached = functionComponentBindingStates.get(props);
  if (cached) {
    return cached;
  }

  // 优先消费 JSX 运行时提前标好的 handler keys；只有缺失时才回退到
  // `onXxx` 约定，这样不同入口拿到的是同一份分流结果。
  const metadataKeys = getFunctionComponentBindingMetadata(props)?.handlerKeys;
  const handlerKeys = new Set<string>(
    metadataKeys && metadataKeys.length > 0
      ? metadataKeys.map(String)
      : inferHandlerKeysFromProps(props)
  );
  const state: FunctionComponentBindingState = {
    handlerKeys,
  };
  functionComponentBindingStates.set(props, state);
  return state;
};

const resolveNamedSlotContent = (
  content: unknown,
  name?: string,
  fallbackToDefault = true
): unknown => {
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const record = content as Record<string, unknown>;
    if (!name) {
      return record.default;
    }
    return record[name] ?? (fallbackToDefault ? record.default : undefined);
  }

  if (!name) {
    return content;
  }

  return undefined;
};

const invokeSlotContent = (
  content: unknown,
  args: readonly unknown[]
): unknown => {
  return typeof content === 'function'
    ? (content as (...values: unknown[]) => unknown)(...args)
    : content;
};

const renderResolvedSlotContent = (
  scope: RuntimeScope | undefined,
  name: string | undefined,
  fallback?: unknown,
  args: readonly unknown[] = [],
  contentOverride?: unknown
): unknown => {
  // 编译后的 Custom Element 没有 slotContent scope，children 会以 props 传入；
  // 有 override 时优先使用它，否则继续走 runtime scope。
  const resolvedContent =
    contentOverride !== undefined
      ? resolveNamedSlotContent(contentOverride, name)
      : resolveNamedSlotContent(scope?.slotContent, name);

  // 函数型 slot 无法通过原生 <slot> 投影，直接调用并把结果交给文本 slot 接管。
  if (typeof resolvedContent === 'function') {
    return invokeSlotContent(resolvedContent, args);
  }

  // Shadow DOM 宿主下保留原生 `<slot>`，这样外部投影和当前运行时读取
  // 可以共存；非 Shadow DOM 场景再直接展开为可渲染内容。
  if (scope?.host instanceof HTMLElement && scope.host.shadowRoot) {
    const slot = document.createElement('slot');
    if (name) {
      slot.name = name;
    }
    appendRenderable(slot, (resolvedContent ?? fallback) as never);
    return slot;
  }

  if (resolvedContent !== undefined && resolvedContent !== null) {
    return invokeSlotContent(resolvedContent, args);
  }

  return invokeSlotContent(fallback, args);
};

const registerFunctionComponentCleanup = (
  cleanup: FunctionComponentCleanup
): void => {
  currentScope?.functionComponentCleanups?.add(cleanup);
};

export const runRenderableCleanups = (
  value: unknown,
  fired: Set<FunctionComponentCleanup> = new Set()
): void => {
  if (!(value instanceof Node)) {
    return;
  }

  const cleanups = renderableCleanupRegistry.get(value);
  if (cleanups) {
    cleanups.forEach((cleanup) => {
      if (fired.has(cleanup)) {
        return;
      }
      fired.add(cleanup);
      cleanup();
    });
    renderableCleanupRegistry.delete(value);
  }

  [...value.childNodes].forEach((child) => {
    runRenderableCleanups(child, fired);
  });
};

export const attachFunctionComponentBindingMetadata = <T extends object>(
  props: T,
  metadata?: FunctionComponentBindingMetadata
): T => {
  // handlerKeys 会决定同一份 props 视图里哪些键走“事件/回调视图”，
  // 哪些键走“普通数据视图”。这里在入口统一归一化，避免后续每次绑定时再重复推断。
  const nextMetadata: FunctionComponentBindingMetadata = {
    handlerKeys:
      metadata?.handlerKeys && metadata.handlerKeys.length > 0
        ? [...new Set(metadata.handlerKeys.map(String))]
        : inferHandlerKeysFromProps(props),
  };

  Object.defineProperty(props, FUNCTION_COMPONENT_BINDING_METADATA, {
    value: nextMetadata,
    enumerable: false,
    configurable: true,
    writable: false,
  });

  functionComponentBindingStates.delete(props);
  return props;
};

export const registerFunctionComponentRenderResult = (
  result: unknown,
  cleanups: Set<FunctionComponentCleanup>
): void => {
  if (cleanups.size === 0) {
    return;
  }

  // 一个函数组件结果值可能最终展开成多个节点；这里把 cleanup 绑定到
  // 所有可收集到的渲染节点上，后续 replace/unmount 时就能统一触发。
  collectRenderableNodes(result as never).forEach((node) => {
    const registered =
      renderableCleanupRegistry.get(node) ??
      new Set<FunctionComponentCleanup>();
    cleanups.forEach((cleanup) => {
      registered.add(cleanup);
    });
    renderableCleanupRegistry.set(node, registered);
  });
};

const requireComponentProps = (
  apiName: 'bindProps' | 'bindHandlers'
): object => {
  const props = getCurrentComponentProps();

  if (!props) {
    throw new Error(
      `${apiName}() must be called while a component is being set up; ` +
        'no component props context is active.'
    );
  }

  return props;
};

/**
 * 基于指定 props 创建普通属性视图。
 *
 * 编译器会把零参 `bindProps()` 重写成 `createBoundProps(this.props)`，
 * 业务代码不需要、也不应该直接调用它。
 */
export const createBoundProps = <T extends object>(props: T): BoundProps<T> => {
  const state = getFunctionComponentBindingState(props);
  if (!state.propsView) {
    // props/handlers 分成两套只读代理视图：
    // 1. props 视图屏蔽 handler key，避免模板把事件函数误当普通值消费；
    // 2. handlers 视图只暴露 handler key，便于编译产物按职责读取。
    // 视图对象本身只创建一次，属性值始终按需回读原始 props。
    state.propsView = createBindingView(
      props,
      (key) => !state.handlerKeys.has(key)
    );
  }

  return state.propsView as BoundProps<T>;
};

/**
 * 基于指定 props 创建回调视图。
 *
 * 同 `createBoundProps()`：编译器内部使用，业务代码请调用 `bindHandlers()`。
 */
export const createBoundHandlers = <T extends object>(
  props: T
): BoundHandlers<T> => {
  const state = getFunctionComponentBindingState(props);
  if (!state.handlersView) {
    // handlers 视图与 props 视图共享同一份源对象，只是 key 过滤条件相反。
    state.handlersView = createBindingView(props, (key) =>
      state.handlerKeys.has(key)
    );
  }

  return state.handlersView as BoundHandlers<T>;
};

/** 读取当前组件的普通属性视图（排除了 `onXxx` 回调）。 */
export const bindProps = <
  T extends object = Record<string, any>,
>(): BoundProps<T> => {
  return createBoundProps(requireComponentProps('bindProps')) as BoundProps<T>;
};

/** 读取当前组件的回调视图（只包含 `onXxx` 回调）。 */
export const bindHandlers = <
  T extends object = Record<string, any>,
>(): BoundHandlers<T> => {
  return createBoundHandlers(
    requireComponentProps('bindHandlers')
  ) as BoundHandlers<T>;
};

export const bindSlots = (props?: { children?: unknown }): SlotBindings => {
  const readSlotContent = (): unknown => {
    const scopeContent = getCurrentRuntimeScope()?.slotContent;
    return scopeContent !== undefined && scopeContent !== null
      ? scopeContent
      : props?.children;
  };

  return {
    has(name) {
      // `has('footer')` 只表示具名槽本身是否存在，不能被默认槽兜底误导。
      const content = resolveNamedSlotContent(readSlotContent(), name, false);
      return content !== undefined && content !== null;
    },
    get(name) {
      return resolveNamedSlotContent(readSlotContent(), name);
    },
    render(name, fallback, ...args) {
      return renderResolvedSlotContent(
        getCurrentRuntimeScope(),
        name,
        fallback,
        args,
        readSlotContent()
      );
    },
    renderDefault(fallback, ...args) {
      return renderResolvedSlotContent(
        getCurrentRuntimeScope(),
        undefined,
        fallback,
        args,
        readSlotContent()
      );
    },
  };
};

/**
 * 子组件 `ref` 的声明类型。
 *
 * 编译产物会把父组件的 `ref={panelRef}` 改写成赋值函数，所以运行时既可能收到
 * 函数 ref、也可能收到对象 ref；声明面上则直接写成公开面本身（`T`）。
 */
export type RefProp<T> = T | RefBinding<T> | null | undefined;

export const createExpose = <T extends object>(
  props: { ref?: RefProp<T> },
  exposed: T
): T => {
  const ref = props.ref;

  if (!ref) {
    return exposed;
  }

  // 组件 ref 需要优先回写暴露面；记录后由 ComponentSlot 统一写入父组件。
  markRefExposed(ref, exposed);

  if (typeof ref === 'function' || 'current' in ref) {
    setRef(ref as RefBinding<T>, exposed);
    // expose 走的还是现有 ref 通道，所以只要把清理挂进当前函数组件
    // 的 render result cleanup 链，替换内容或卸载时就能自动置空。
    registerFunctionComponentCleanup(() => setRef(ref as RefBinding<T>, null));
  }

  return exposed;
};

/**
 * `defineComponent(fn, options)` 的选项。
 *
 * 这些选项只被 `.lania.tsx` 编译器读取（生成 `static propOptions` / `static emits`），
 * 运行时收到后不会再做二次解释。
 */
export interface DefineComponentOptions {
  props?: PropOptionsMap;
  emits?: readonly string[];
}

export const defineComponent = <T extends FunctionComponent<any, any>>(
  component: T,
  _options?: DefineComponentOptions
): T & ComponentElementConstructor => {
  const defined = component as T & ComponentElementConstructor;
  if (isComponentElementConstructor(defined)) {
    // 若传入的其实是自定义元素构造器，则顺手完成注册。
    registerComponentElement(defined);
  }
  return defined;
};

export const isComponentElementConstructor = (
  value: unknown
): value is ComponentElementConstructor => {
  return typeof value === 'function' && value.prototype instanceof HTMLElement;
};

const inferComponentTagName = (rawName: string): string | null => {
  // 把 PascalCase / camelCase / displayName 统一规范成合法 custom element 名称。
  const base = rawName
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

  if (!base) {
    return null;
  }

  const withHyphen = base.includes('-') ? base : `x-${base}`;
  return withHyphen.startsWith('xml') ? `x-${withHyphen}` : withHyphen;
};

export const getComponentTagName = (ctor: unknown): string | null => {
  if (!ctor || typeof ctor !== 'function') {
    return null;
  }

  const explicitTagName = (ctor as { tagName?: unknown }).tagName;
  if (
    typeof explicitTagName === 'string' &&
    explicitTagName.trim().length > 0
  ) {
    return explicitTagName;
  }

  const displayName = (ctor as { displayName?: unknown }).displayName;
  if (typeof displayName === 'string' && displayName.trim().length > 0) {
    return inferComponentTagName(displayName);
  }

  const name = (ctor as { name?: unknown }).name;
  return typeof name === 'string' && name.trim().length > 0
    ? inferComponentTagName(name)
    : null;
};

// 同名标签重复注册时只提示一次，避免每次渲染都刷屏。
const reportedTagConflicts = new Set<string>();

const registerComponentElement = <T extends ComponentElementConstructor>(
  ctor: T,
  options: EnsureCustomElementOptions = {}
): T => {
  const tagName = options.tagName ?? getComponentTagName(ctor);

  if (!tagName) {
    throw new TypeError(
      'Unable to resolve a custom element tag name for the component constructor.'
    );
  }

  if (
    typeof customElements !== 'undefined' &&
    typeof customElements.define === 'function'
  ) {
    const existing = customElements.get(tagName) as T | undefined;
    if (existing) {
      // 开发态 HMR：同名标签的新构造器不会重新 define，而是热替换原型并重挂载现有实例。
      if (existing !== ctor && isDevEnvironment() && isComponentHmrEnabled()) {
        applyComponentHmrUpdate(tagName, ctor as HmrComponentConstructor);
        const hmrStyles = options.styles ?? existing.styles;
        if (hmrStyles !== undefined) {
          existing.styles = hmrStyles;
        }
        return existing;
      }

      // 已注册时浏览器会以先注册的构造器为准，后到的实现会被静默丢弃。
      // 这里显式告警，并把 styles 写回真正生效的构造器，避免版本错配难以排查。
      if (
        existing !== ctor &&
        isDevEnvironment() &&
        !reportedTagConflicts.has(tagName)
      ) {
        reportedTagConflicts.add(tagName);
        console.warn(
          `[lania-v] <${tagName}> is already registered by another constructor; ` +
            `the later definition (${ctor.displayName ?? ctor.name ?? 'anonymous'}) is ignored. ` +
            'Check for duplicate bundles or mismatched versions.'
        );
      }

      const existingStyles = options.styles ?? existing.styles;
      if (existingStyles !== undefined) {
        existing.styles = existingStyles;
      }

      return existing;
    }

    customElements.define(tagName, ctor);
  }

  const styles = options.styles ?? ctor.styles;
  if (styles !== undefined) {
    ctor.styles = styles;
  }

  return ctor;
};
/**
 * 组件构造期可用的 props 快照栈。
 *
 * Custom Element 的字段初始化发生在构造器里，此时 `document.createElement` 还没返回，
 * 外部也无法再注入 props。这里在构造期间临时暴露本次要传入的 props，
 * 让编译产物里的 `props` 字段能在字段初始化阶段拿到真实对象。
 */
const componentCreationPropsStack: Array<Record<string, unknown>> = [];

export const getComponentCreationProps = (): Record<string, unknown> | null => {
  return componentCreationPropsStack.length > 0
    ? componentCreationPropsStack[componentCreationPropsStack.length - 1]!
    : null;
};

/**
 * 构造期生成组件实例的 props 快照。
 *
 * 视图的 key 集合在创建时就固定下来了，因此这里必须补齐所有编译期声明的 prop。
 * 已声明的 prop 用 getter 回读实例上的同名 prop signal，`bindProps()` 读取时
 * 才能正常收集依赖；未声明的动态 key 仍按普通快照值处理。
 */
export const createComponentPropsSnapshot = (
  instance: object,
  propNames: readonly string[]
): Record<string, unknown> => {
  const incoming = getComponentCreationProps() ?? {};
  const snapshot: Record<string, unknown> = {};

  for (const name of propNames) {
    let current = incoming[name];
    Object.defineProperty(snapshot, name, {
      enumerable: true,
      configurable: true,
      get() {
        return name in instance
          ? (instance as Record<string, unknown>)[name]
          : current;
      },
      set(value: unknown) {
        current = value;
      },
    });
  }

  for (const [key, value] of Object.entries(incoming)) {
    if (!(key in snapshot)) {
      snapshot[key] = value;
    }
  }

  // handler 分流结果挂在原始入参上，快照对象需要继承同一份 metadata。
  // 手动创建或 SSR 升级时构造期没有入参，回落到编译期生成的静态 handlerKeys，
  // 保证仅声明、尚未赋值的回调也能被 bindHandlers() 分到事件视图。
  const declaredHandlerKeys = (
    instance.constructor as ComponentElementConstructor
  ).handlerKeys;
  const metadata =
    getFunctionComponentBindingMetadata(incoming) ??
    (declaredHandlerKeys && declaredHandlerKeys.length > 0
      ? { handlerKeys: declaredHandlerKeys }
      : undefined);
  if (metadata) {
    attachFunctionComponentBindingMetadata(snapshot, metadata);
  }

  // 快照建好后接管当前构造期的 props 上下文，后续字段里的 `bindProps()`
  // 读到的就是能回读实例 signal 的快照，而不是构造期入参。
  const context =
    componentPropsContextStack[componentPropsContextStack.length - 1];
  if (context && context.props === incoming) {
    context.props = snapshot;
  }

  return snapshot;
};

const createElementWithProps = <T>(
  props: Record<string, unknown>,
  create: () => T
): T => {
  const propsContext: ComponentPropsContext = { props };
  componentCreationPropsStack.push(props);
  componentPropsContextStack.push(propsContext);

  try {
    return create();
  } finally {
    componentPropsContextStack.pop();
    componentCreationPropsStack.pop();
  }
};

export const createComponentElement = <T extends ComponentElementConstructor>(
  ctor: T,
  options: CreateComponentElementOptions = {}
): InstanceType<T> => {
  const registered = registerComponentElement(ctor, options);
  const tagName = options.tagName ?? getComponentTagName(registered);

  if (!tagName) {
    throw new TypeError(
      'Unable to create a component element without a resolved tag name.'
    );
  }

  const props = options.props ?? {};
  // 编译期能直接给出 handler 名单，先挂 metadata，保证 handler 尚未传入时
  // bindHandlers() 也能把对应 key 分到事件视图。
  if (registered.handlerKeys && registered.handlerKeys.length > 0) {
    attachFunctionComponentBindingMetadata(props, {
      handlerKeys: registered.handlerKeys,
    });
  }

  // `document.createElement` 会同步执行构造器与字段初始化，因此 props 必须在这之前入栈。
  const element = createElementWithProps(props, () => {
    return document.createElement(tagName) as InstanceType<T>;
  });

  for (const [key, value] of Object.entries(props)) {
    // 这里走 property 赋值，而不是 attribute，便于直接传对象/函数等运行时值。
    (element as Record<string, unknown>)[key] = value;
  }

  return element;
};

export const mountComponent = <T extends ComponentElementConstructor>(
  container: Element | DocumentFragment | ShadowRoot,
  ctor: T,
  options: CreateComponentElementOptions = {}
): InstanceType<T> => {
  const element = createComponentElement(ctor, options);
  createRoot(container).render(element);
  return element;
};

export type FunctionLifecycleCallback<TArgs extends unknown[] = []> = (
  ...args: TArgs
) => unknown;

const createCompileOnlyApiError = (name: string): Error => {
  return new Error(
    `${name}() is compile-time only. It must be rewritten by the Lania compiler inside a compiled component instead of running in the public runtime directly.`
  );
};

const throwCompileOnlyApiError = (name: string): never => {
  throw createCompileOnlyApiError(name);
};

// 这些生命周期 API 只作为编译器识别标记存在。
// 若在未编译的公开运行时里直接调用，应显式抛错，避免静默失效。
export const onMount = (_callback: FunctionLifecycleCallback): void => {
  throwCompileOnlyApiError('onMount');
};
export const onMounted = onMount;
export const onCleanup = (_callback: FunctionLifecycleCallback): void => {
  throwCompileOnlyApiError('onCleanup');
};
export const onUnmounted = onCleanup;
export const onUpdated = (
  _callback: FunctionLifecycleCallback<[ChangedProps]>
): void => {
  throwCompileOnlyApiError('onUpdated');
};

/**
 * 声明组件参与原生表单提交。
 *
 * 编译器会把 `useFormValue(() => expr)` 改写成两部分：
 * - 类上生成 `static formAssociated = true`；
 * - 一个 effect updater，在依赖变化时调用 `_setFormValue(expr)`。
 *
 * 因此这个函数本身只作为编译期标记存在，未编译时直接调用应显式报错。
 */
export const useFormValue = (_getter: () => unknown): void => {
  throwCompileOnlyApiError('useFormValue');
};

/**
 * 声明组件参与原生表单校验。
 *
 * 编译器会把 `useFormValidity(() => expr)` 改写成一个 effect updater，
 * 在依赖变化时调用 `_setFormValidity(expr)`；返回 `true` 表示通过，
 * 返回 `{ valid: false, message }` 或 `false` 时会调用 `setValidity`。
 */
export const useFormValidity = (_getter: () => unknown): void => {
  throwCompileOnlyApiError('useFormValidity');
};

export const withRuntimeScope = <T>(scope: RuntimeScope, run: () => T): T => {
  const previousScope = currentScope;
  currentScope = {
    // 作用域采用浅合并：内层调用只覆盖自己显式声明的字段，
    // 未声明的 host / slotContent / domHost 继续继承外层上下文。
    ...(previousScope ?? {}),
    ...scope,
  };

  try {
    return run();
  } finally {
    // 作用域按栈式恢复，保证嵌套调用不会污染外层运行时上下文。
    currentScope = previousScope;
  }
};

export const withContextHost = <T>(host: RuntimeScopeHost, run: () => T): T => {
  return withRuntimeScope({ host }, run);
};

export const withDomHost = <T>(target: DomHostTarget, run: () => T): T => {
  return withRuntimeScope({ domHost: target }, run);
};

export const useContext = <T>(
  context: Context<T>,
  host?: RuntimeScopeHost
): ReadonlySignal<T> => {
  const resolvedHost = host ?? currentScope?.host;

  if (!resolvedHost) {
    // 没有宿主时直接退回 context 默认值，维持函数式调用的可用性。
    return context.defaultValue;
  }

  return consumeContext(resolvedHost, context);
};

export const createRoot = (
  container: Element | DocumentFragment | ShadowRoot
): Root => {
  // createRoot 只负责把“已经可渲染”的值挂到容器。
  // 它不是 React 风格的调度根，也不会执行组件函数引用或做 diff。
  const clear = () => {
    const firedCleanups = new Set<FunctionComponentCleanup>();
    while (container.firstChild) {
      runRenderableCleanups(container.firstChild, firedCleanups);
      container.removeChild(container.firstChild);
    }
  };
  const throwUnsupportedFunctionInput = (): never => {
    throw new TypeError(
      'createRoot().render() only accepts already-rendered values. Pass JSX (`<App />`) or the result of invoking a component (`App(props)`), not a function reference.'
    );
  };
  const appendRenderable = (value: unknown): void => {
    if (value == null || value === false) {
      // 与模板运行时保持一致：null / undefined / false 都视为空渲染结果。
      return;
    }

    if (Array.isArray(value)) {
      // 轻量 root 支持递归展开数组，便于直接消费 JSX 编译后的 children 结果。
      value.forEach((entry) => appendRenderable(entry));
      return;
    }

    if (typeof value === 'function') {
      throwUnsupportedFunctionInput();
    }

    if (typeof value === 'string' || typeof value === 'number') {
      container.append(String(value));
      return;
    }

    if (value instanceof Node) {
      container.appendChild(value);
    }
  };

  return {
    render(content) {
      clear();

      appendRenderable(content);
    },
    unmount() {
      clear();
    },
  };
};

export const lazy = <T extends FunctionComponent<any, any>>(
  loader: () => Promise<LazyResolvedModule<T>>
): LazyComponent<T> => {
  let resolvedComponent: T | null = null;
  let pending: Promise<T> | null = null;

  const load = async (): Promise<T> => {
    const loaded = await loader();
    // 同时兼容直接导出组件与 `{ default: Component }` 两种懒加载模块形态。
    resolvedComponent = typeof loaded === 'function' ? loaded : loaded.default;
    return resolvedComponent;
  };

  const component = ((...args: Parameters<T>): ReturnType<T> => {
    if (resolvedComponent) {
      // 一旦 resolve 完成，后续调用退化为普通同步组件调用，不再触发 Suspense。
      const callable = resolvedComponent as (
        ...params: Parameters<T>
      ) => ReturnType<T>;
      return callable(...args);
    }

    // 通过 throw Promise 触发上层 Suspense：这是常见的“资源悬挂”模式。
    throw (pending ??= load());
  }) as LazyComponent<T>;

  component.preload = () => {
    // preload 只负责确保同一个 pending promise 被复用，不主动改写 resolved 读取语义。
    pending ??= load();
    return pending;
  };
  component.resolved = () => resolvedComponent;

  return component;
};
