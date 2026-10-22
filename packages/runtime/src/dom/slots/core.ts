/**
 * DOM slot 基础实现。
 *
 * 这里放的是最底层、最通用的 slot 原语和 DOM 操作辅助：
 * - 文本、属性、style、class、property、event 这类基础 slot；
 * - 动态 children 的挂载 / 协调 / 移除；
 * - 事件代理与属性重置等通用细节。
 *
 * 更复杂的 `IfSlot` / `ForSlot` / `DynamicSlot` / `BoundarySlot` 会在其它文件中实现，
 * 但最终仍然依赖这里的基础写入语义和 DOM 节点操作工具。
 *
 * 设计上这里尽量只做“最小但可复用”的 DOM 原语：
 * - 单个 slot 只关心自己如何写值与销毁；
 * - 复杂结构协调则下沉为若干无状态工具函数；
 * - 与 Transition / KeepAlive 的联动点集中在事件代理、锚点解析与 hook flush。
 */
import {
  applyStyleObject,
  applyStyleValue,
  type StyleObject,
} from '../../component/styles';
import { writeClassAttribute } from '../class-value';
import { writeStyleAttribute } from '../style-value';
import { flushHooksForNodes } from '../../component/transition/host';
import { resolveAnchorDomTarget } from '../../component/lifecycle/keepalive-registry';
import {
  attachDelegatedEventListener,
  detachDelegated,
  shouldUseDelegatedEventListener,
} from '../../component/events';
import type { KeyedBlock } from './template/template-types';

export type SlotType =
  | 'text'
  | 'attribute'
  | 'style'
  | 'class'
  | 'property'
  | 'event'
  | 'if'
  | 'for'
  | 'component'
  | 'dynamic'
  | 'boundary'
  | 'teleport'
  | 'keepalive'
  | 'directive'
  | 'ref'
  | 'style-map';
export type SlotFrequency = 'high' | 'normal' | 'low';

export interface Slot<T = unknown> {
  type: SlotType;
  node: EventTarget | Node | Element | HTMLElement;
  index: number;
  frequency: SlotFrequency;
  write(value: T): void;
  destroy(): void;
}

const isNodeLike = (
  value: unknown
): value is Node | DocumentFragment | readonly Node[] => {
  if (value == null || value === false) {
    return false;
  }

  if (value instanceof Node || value instanceof DocumentFragment) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(
      (entry) =>
        entry == null ||
        entry === false ||
        entry instanceof Node ||
        Array.isArray(entry)
    );
  }

  return false;
};

// TextSlot 是最轻量的 slot：只负责把值写进单个 Text 节点。
export class TextSlot implements Slot<unknown> {
  readonly type = 'text';
  readonly frequency = 'normal';
  private previous: string;
  injectedNodes: Node[] = [];

  constructor(
    public readonly node: Text,
    public readonly index: number
  ) {
    this.previous = node.data;
  }

  // 结构型调用方（KeepAlive/Transition 等）按 `currentNodes` 读取区间，
  // 注入节点必须一并暴露，否则会被当成“空文本槽”而漏搬真实 DOM。
  get currentNodes(): Node[] | null {
    return this.injectedNodes.length > 0
      ? [this.node, ...this.injectedNodes]
      : null;
  }

  private clearInjectedNodes(): void {
    if (this.injectedNodes.length === 0) {
      return;
    }

    this.injectedNodes.forEach((node) => {
      node.parentNode?.removeChild(node);
    });
    this.injectedNodes.length = 0;
  }

  write(value: unknown): void {
    if (isNodeLike(value)) {
      this.clearInjectedNodes();
      const nextNodes = normalizeDynamicResult(value);
      const parent = this.node.parentNode;
      if (parent) {
        let anchor: Node = this.node;
        nextNodes.forEach((node) => {
          parent.insertBefore(node, anchor.nextSibling);
          anchor = node;
        });
      }
      this.injectedNodes = nextNodes;
      this.node.data = '';
      this.previous = '';
      return;
    }

    this.clearInjectedNodes();
    const nextValue = value == null ? '' : String(value);
    if (this.previous === nextValue) {
      return;
    }
    this.node.data = nextValue;
    this.previous = nextValue;
  }

  destroy(): void {
    this.clearInjectedNodes();
    if (this.previous === '') {
      return;
    }
    this.node.data = '';
    this.previous = '';
  }
}

// AttrSlot 统一处理普通 attribute，同时对 class/style/部分 DOM property 提供特化逻辑。
export class AttrSlot implements Slot<unknown> {
  readonly type = 'attribute';
  readonly frequency = 'low';
  private readonly staticClassValue: string;
  private readonly staticStyleValue: string;
  private previous: unknown = Symbol('lania-attr-initial');

  constructor(
    public readonly node: Element,
    public readonly name: string,
    public readonly index: number
  ) {
    this.staticClassValue =
      this.name === 'class' ? (this.node.getAttribute('class') ?? '') : '';
    this.staticStyleValue =
      this.name === 'style' ? (this.node.getAttribute('style') ?? '') : '';
  }

  private writeFastDomProperty(value: unknown): boolean {
    if (!(this.node instanceof HTMLElement)) {
      return false;
    }

    const resetValue = FAST_DOM_PROPERTY_RESET_VALUES[this.name];

    if (
      resetValue === undefined ||
      !(this.name in (this.node as unknown as Record<string, unknown>))
    ) {
      return false;
    }

    writeComponentProp(
      this.node,
      this.name,
      value == null || value === false ? resetValue : value
    );

    if (value == null || value === false) {
      // property 被重置时，也同步移除对应 attribute，避免 DOM 状态残留。
      this.node.removeAttribute(this.name);
    }

    return true;
  }

  write(value: unknown): void {
    if (Object.is(this.previous, value)) {
      return;
    }

    if (this.writeFastDomProperty(value)) {
      this.previous = value;
      return;
    }

    if (this.name === 'class') {
      writeClassAttribute(this.node, value, this.staticClassValue);
      this.previous = value;
      return;
    }

    if (this.name === 'style') {
      writeStyleAttribute(this.node, value, this.staticStyleValue);
      this.previous = value;
      return;
    }

    if (value == null || value === false) {
      this.node.removeAttribute(this.name);
      this.previous = value;
      return;
    }

    this.node.setAttribute(this.name, String(value));
    this.previous = value;
  }

  destroy(): void {
    if (Object.is(this.previous, null)) {
      return;
    }

    if (this.writeFastDomProperty(null)) {
      this.previous = null;
      return;
    }

    if (this.name === 'class') {
      writeClassAttribute(this.node, null, this.staticClassValue);
      this.previous = null;
      return;
    }

    if (this.name === 'style') {
      writeStyleAttribute(this.node, null, this.staticStyleValue);
      this.previous = null;
      return;
    }

    this.node.removeAttribute(this.name);
    this.previous = null;
  }
}

// StyleSlot 只维护单个 style 属性；对象 style 的 diff 则交给 StyleObjectSlot。
export class StyleSlot implements Slot<unknown> {
  readonly type = 'style';
  readonly frequency = 'high';

  constructor(
    public readonly node: HTMLElement,
    public readonly property: string,
    public readonly index: number,
    public readonly unit = ''
  ) {}

  write(value: unknown): void {
    applyStyleValue(
      this.node,
      this.property,
      value as string | number | boolean | null,
      this.unit
    );
  }

  destroy(): void {
    applyStyleValue(this.node, this.property, null);
  }
}

// StyleObjectSlot 用于 `style={{ ... }}` 这类整体 style map，需要记录上一次写入结果做差量清理。
export class StyleObjectSlot implements Slot<StyleObject> {
  readonly type = 'style-map';
  readonly frequency = 'high';
  private previous: StyleObject = {};

  constructor(
    public readonly node: HTMLElement,
    public readonly index: number
  ) {}

  write(value: StyleObject): void {
    this.previous = applyStyleObject(this.node, value, this.previous);
  }

  destroy(): void {
    this.previous = applyStyleObject(this.node, {}, this.previous);
  }
}

// ClassSlot 对应 `class:foo={expr}` 这类布尔 class 开关。
export class ClassSlot implements Slot<boolean> {
  readonly type = 'class';
  readonly frequency = 'normal';

  constructor(
    public readonly node: HTMLElement,
    public readonly className: string,
    public readonly index: number
  ) {}

  write(value: boolean): void {
    this.node.classList.toggle(this.className, Boolean(value));
  }

  destroy(): void {
    this.node.classList.remove(this.className);
  }
}

// 某些 DOM property 在运行时表现得像 signal/setter，对它们写值时优先走 `.set()`。
const isSignalLike = (
  value: unknown
): value is ((...args: never[]) => unknown) & {
  set(next: unknown): unknown;
} => {
  return (
    typeof value === 'function' &&
    typeof (value as { set?: unknown }).set === 'function'
  );
};

// 销毁 property slot 时，一部分常用 DOM property 需要写回更安全的默认值。
export const FAST_DOM_PROPERTY_RESET_VALUES: Record<string, unknown> = {
  value: '',
  checked: false,
  selected: false,
  disabled: false,
  selectedIndex: -1,
  readOnly: false,
  multiple: false,
  muted: false,
};

// 把 prop 写入目标元素；若目标字段本身是 signal-like，则走 setter 语义而非直接覆盖。
export const writeComponentProp = (
  target: Element | HTMLElement,
  name: string,
  value: unknown
): void => {
  const record = target as unknown as Record<string, unknown>;
  const current = record[name];

  if (isSignalLike(current)) {
    current.set(value);
    return;
  }

  record[name] = value;
};

// PropSlot 直接写 DOM/property，而不经过 attribute 序列化。
export class PropSlot implements Slot<unknown> {
  readonly type = 'property';
  readonly frequency = 'normal';

  constructor(
    public readonly node: Element | HTMLElement,
    public readonly name: string,
    public readonly index: number
  ) {}

  write(value: unknown): void {
    writeComponentProp(this.node, this.name, value);
  }

  destroy(): void {
    writeComponentProp(this.node, this.name, undefined);
  }
}

export class EventSlot implements Slot<EventListener | null | undefined> {
  readonly type = 'event';
  readonly frequency = 'high';
  private currentHandler: EventListener | null = null;
  private readonly listener = (event: Event) => {
    this.currentHandler?.(event);
  };
  private attached = false;
  private delegated = false;

  constructor(
    public readonly node: EventTarget,
    public readonly eventName: string,
    public readonly index: number,
    private readonly options?: AddEventListenerOptions
  ) {}

  write(value: EventListener | null | undefined): void {
    this.currentHandler = value ?? null;

    if (!this.attached) {
      // 首次写入时才真正挂监听；后续更新只替换 currentHandler 引用，避免频繁 add/remove。
      if (
        shouldUseDelegatedEventListener(this.node, this.eventName, this.options)
      ) {
        this.delegated = attachDelegatedEventListener(
          this.node,
          this.eventName,
          this.listener
        );
      }

      if (!this.delegated) {
        this.node.addEventListener(this.eventName, this.listener, this.options);
      }

      this.attached = true;
    }
  }

  destroy(): void {
    if (this.attached) {
      if (this.delegated) {
        detachDelegated(this.node, this.eventName, this.listener);
      } else {
        this.node.removeEventListener(
          this.eventName,
          this.listener,
          this.options
        );
      }

      this.attached = false;
      this.delegated = false;
    }

    this.currentHandler = null;
  }
}

// 工厂函数允许直接返回 Node/Node[]/Fragment，slot 层统一拍平成稳定数组处理。
export const cloneFactoryNodes = (
  factory:
    (() => Node | Node[] | DocumentFragment | null | undefined) | undefined
): Node[] => {
  if (!factory) {
    return [];
  }

  const created = factory();

  if (!created) {
    return [];
  }

  if (created instanceof DocumentFragment) {
    return [...created.childNodes];
  }

  return Array.isArray(created) ? created : [created];
};

export const appendNodesBeforeAnchor = (
  parent: Node,
  anchor: Node,
  nodes: readonly Node[]
): void => {
  const resolved = resolveAnchorDomTarget({ parent, anchor });
  nodes.forEach((node) => {
    resolved.parent.insertBefore(node, resolved.anchor);
  });
  if (resolved.parent.isConnected) {
    // 新节点一旦进入已连接树，立即冲刷挂起的 transition hook，保持插入时机与真实挂载一致。
    flushHooksForNodes(nodes);
  }
};

export const insertNodeBeforeSafe = (
  parent: Node,
  node: Node,
  beforeNode: Node | null
): void => {
  const resolvedBeforeNode =
    beforeNode && beforeNode.parentNode === parent ? beforeNode : null;
  // appendChild 比 insertBefore(node, null) 少一次空值分支处理，是离屏拼装的常用路径。
  if (resolvedBeforeNode) {
    parent.insertBefore(node, resolvedBeforeNode);
    return;
  }
  parent.appendChild(node);
};

export const collectKeyedBlockElements = (block: KeyedBlock): HTMLElement[] => {
  // keyed block 主要服务于 TransitionGroup/For 等需要回看一段 DOM 区间的场景。
  if (block.element) {
    return block.element instanceof HTMLElement ? [block.element] : [];
  }

  const elements: HTMLElement[] = [];
  let current: ChildNode | null = block.start?.nextSibling ?? null;
  while (current && current !== block.end) {
    if (current instanceof HTMLElement) {
      elements.push(current);
    }
    current = current.nextSibling;
  }
  return elements;
};

export const collectKeyedBlockNodes = (block: KeyedBlock): Node[] => {
  if (block.element) {
    return [block.element];
  }

  const nodes: Node[] = [];
  let current: ChildNode | null = block.start?.nextSibling ?? null;
  while (current && current !== block.end) {
    nodes.push(current);
    current = current.nextSibling;
  }
  return nodes;
};

export const removeNodes = (nodes: readonly Node[]): void => {
  nodes.forEach((node) => {
    node.parentNode?.removeChild(node);
  });
};

export const reconcileNodesBeforeAnchor = (
  parent: Node,
  anchor: Node,
  currentNodes: readonly Node[],
  nextNodes: readonly Node[]
): void => {
  const resolved = resolveAnchorDomTarget({ parent, anchor });
  const nextNodeSet = new Set(nextNodes);

  // 先删掉不再属于 next 集合的旧节点，再从尾到头校正顺序，减少锚点失效风险。
  currentNodes.forEach((node) => {
    if (!nextNodeSet.has(node) && node.parentNode === resolved.parent) {
      resolved.parent.removeChild(node);
    }
  });

  let beforeNode: Node | null = resolved.anchor;
  for (let index = nextNodes.length - 1; index >= 0; index -= 1) {
    const node = nextNodes[index]!;
    if (
      node.parentNode !== resolved.parent ||
      node.nextSibling !== beforeNode
    ) {
      resolved.parent.insertBefore(node, beforeNode);
      if (resolved.parent.isConnected) {
        flushHooksForNodes([node]);
      }
    }

    beforeNode = node;
  }
};

// dynamic children 允许嵌套数组、原生节点和 fragment，这里统一规整成 Node[]。
export const normalizeDynamicResult = (value: unknown): Node[] => {
  if (value == null || value === false) {
    return [];
  }

  if (value instanceof DocumentFragment) {
    return [...value.childNodes];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeDynamicResult(entry));
  }

  if (value instanceof Node) {
    return [value];
  }

  return [document.createTextNode(String(value))];
};

export const setDynamicAttribute = (
  element: Element,
  name: string,
  value: unknown
): void => {
  if (name === 'class') {
    writeClassAttribute(element, value);
    return;
  }

  if (name === 'style') {
    writeStyleAttribute(element, value);
    return;
  }

  if (value == null || value === false) {
    element.removeAttribute(name);
    return;
  }

  element.setAttribute(name, String(value));
};

export const appendDynamicChildren = (
  element: Element | HTMLElement,
  children: readonly Node[]
): void => {
  // 这是“整段替换”语义，不做细粒度 diff；复杂协调由上层 DynamicSlot/ForSlot 负责。
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }

  children.forEach((child) => {
    // 这里保留原始 Node 身份，不主动 clone；调用方若需要复用，必须自己保证节点所有权。
    element.appendChild(child);
  });
};
