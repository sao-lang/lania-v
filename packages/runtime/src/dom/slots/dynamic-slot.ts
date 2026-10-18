/**
 * `DynamicSlot` 运行时实现。
 *
 * 它负责承接 `<component>`、动态组件表达式以及部分增强组件的运行时结果。
 * 与普通文本/属性 slot 不同，这里维护的是“一整段可替换子树”，因此需要同时处理：
 * 1. `component` 值到真实目标类型的解析，包括原生标签、现成元素、组件构造器与函数组件；
 * 2. hydration 首帧对 SSR 既有 DOM 的接管，尽量复用现存子树而不是立即重建；
 * 3. 动态根元素上的 props、事件、指令等二级绑定控制；
 * 4. Transition / TransitionGroup 这类增强组件对结构锚点、子实例和延迟 hook 的特殊需求。
 *
 * 这个文件最重要的不是“怎么创建节点”，而是“什么情况下可以复用已有节点或已有控制器”。
 */
import {
  Await as AwaitComponent,
  isEnhancedDef,
  Slot as SlotComponent,
  Transition,
  TransitionGroup,
  Virtual as VirtualComponent,
} from '../../component/enhanced-components';
import { withEventModifiers } from '../../component/events';
import {
  createGroupState,
  getTransitionGroupState,
  setTransitionGroupState,
} from '../../component/transition/group-registry';
import {
  createTransitionGroupStateKey,
  resolveTransitionGroupHostMode,
} from '../../component/transition/group/runtime/host-mode';
import { withDeferredTransitionHooks } from '../../component/transition/host';
import {
  createComponentElement,
  getComponentTagName,
  isComponentElementConstructor,
  withRuntimeScope,
} from '../../component/host/function-component';
import type { StaticTemplate } from '../../render/types';
import { acquireSlotNodeBuffer, releaseSlotNodeBuffer } from '../slot-pool';
import {
  FAST_DOM_PROPERTY_RESET_VALUES,
  EventSlot,
  appendDynamicChildren,
  appendNodesBeforeAnchor,
  normalizeDynamicResult,
  reconcileNodesBeforeAnchor,
  removeNodes,
  setDynamicAttribute,
  type Slot,
  writeComponentProp,
} from './core';
import { writeClassAttribute } from '../class-value';
import { writeStyleAttribute } from '../style-value';
import {
  createDirectiveSlotForBinding,
  readDynamicDirectives,
  readDynamicEvents,
} from './bindings/directive-slots';
import {
  readMountedNodes,
  readTransitionChildNodes,
  type MountedBindingInstance,
  type TemplateBindingPayload,
} from './template/template-types';
import {
  mountHydratedBinding,
  mountTemplateBinding,
} from './template/template-factory';

type DynamicSlotValue = {
  component: unknown;
  props?: Record<string, unknown>;
  __lania_dynamic?: 'block';
  childBindings?: readonly TemplateBindingPayload[];
};

// 编译产物里某些保留字符串会在运行时映射到真实增强组件构造器。
const resolveDynamicTarget = (target: unknown): unknown => {
  if (target === 'Slot') {
    return SlotComponent;
  }
  if (target === 'Transition') {
    return Transition;
  }
  if (target === 'TransitionGroup') {
    return TransitionGroup;
  }
  if (target === 'Await') {
    return AwaitComponent;
  }
  if (target === 'Virtual') {
    return VirtualComponent;
  }
  return target;
};

// TransitionGroup 在动态 slot 里需要特殊保留结构节点，不能按普通增强组件处理。
const isTransitionGroupTarget = (target: unknown): boolean => {
  return (
    typeof target === 'function' &&
    (target as { displayName?: string }).displayName === 'TransitionGroup'
  );
};

// 对增强组件而言，children 可能不是简单的 DOM 节点数组，而是需要保留函数/结构锚点。
/**
 * 编译后的 scoped slot 会以单个 text child binding 形式传入。
 * 这里识别“求值结果是函数”的形态，并把它作为 children / slotContent 透传，
 * 而不是把函数字符串化后挂成文本节点。
 */
const resolveScopedSlotChild = (
  childBindings: readonly TemplateBindingPayload[]
): unknown => {
  if (childBindings.length !== 1) {
    return undefined;
  }
  const binding = childBindings[0];
  if (binding?.kind !== 'text' || typeof binding.evaluate !== 'function') {
    return undefined;
  }
  const evaluated = binding.evaluate();
  return typeof evaluated === 'function' ? evaluated : undefined;
};

const resolveEnhancedDynamicChildren = (
  childBindings: readonly TemplateBindingPayload[],
  childInstance: MountedBindingInstance | null,
  fallbackChildren: unknown
): unknown => {
  if (
    childBindings.length === 1 &&
    childBindings[0]?.kind === 'text' &&
    typeof childBindings[0].evaluate === 'function'
  ) {
    const evaluated = childBindings[0].evaluate();
    if (typeof evaluated === 'function') {
      return evaluated;
    }
  }

  return childInstance ? readMountedNodes(childInstance) : fallbackChildren;
};

// TransitionGroup 的 DOM host 模式允许通过 `tag` 决定外层容器标签。
const readGroupDomTag = (
  props: Record<string, unknown>
): string | undefined => {
  const directTag = props.tag;
  if (typeof directTag === 'string' && directTag.trim().length > 0) {
    return directTag;
  }

  const payload = props.payload;
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const transition = (payload as { transition?: unknown }).transition;
  if (!transition || typeof transition !== 'object') {
    return undefined;
  }

  const tag = (transition as { tag?: unknown }).tag;
  return typeof tag === 'string' && tag.trim().length > 0 ? tag : undefined;
};

// Group state key 既可能来自显式 key，也可能退化到 name/default。
const readGroupStateKey = (props: Record<string, unknown>): string | null => {
  const payload = props.payload;
  const transition =
    payload && typeof payload === 'object'
      ? (payload as { transition?: unknown }).transition
      : null;
  const transitionRecord =
    transition && typeof transition === 'object'
      ? (transition as { key?: unknown; name?: unknown })
      : null;
  const keySource =
    transitionRecord?.key ??
    props.groupKey ??
    transitionRecord?.name ??
    props.name;

  return keySource == null ? 'default' : String(keySource);
};

// hydration 首轮若遇到 TransitionGroup DOM host，需要先把 SSR 现有容器注册进 group state。
const bootstrapHydratedTransitionGroupDomHostState = (options: {
  props: Record<string, unknown>;
  hydratedNodes: readonly Node[];
}): readonly Node[] | undefined => {
  const { props, hydratedNodes } = options;
  if (hydratedNodes.length !== 1 || !(hydratedNodes[0] instanceof HTMLElement)) {
    return undefined;
  }

  const container = hydratedNodes[0];
  const transitionTag = readGroupDomTag(props);
  if (!transitionTag || container.tagName.toLowerCase() !== transitionTag.toLowerCase()) {
    return undefined;
  }

  const stateKeyBase = readGroupStateKey(props);
  if (!stateKeyBase) {
    return undefined;
  }
  const stateKey = createTransitionGroupStateKey(
    stateKeyBase,
    resolveTransitionGroupHostMode(transitionTag)
  );

  const previous = getTransitionGroupState<unknown>(stateKey);
  if (!previous || previous.container !== container || previous.tag !== transitionTag) {
    setTransitionGroupState(
      stateKey,
      createGroupState({
        keys: [],
        snapshots: [],
        container,
        tag: transitionTag,
        domHostAnchor: null,
        domHostLeaveAnchor: null,
        owner: null,
        activeBlocks: new Map(),
        leavingBlocks: new Map(),
        leavingSnapshots: new Map(),
        leaveVersion: 0,
      })
    );
  }

  return [...container.childNodes];
};

// 当动态结果最终落成一个真实 DOM 元素时，由这个控制器负责持续维护它的 props / events / directives。
class DynamicElementBindingController {
  private eventSlots = new Map<string, EventSlot>();
  private directiveSlots = new Map<string, Slot<unknown>>();
  private previousPropKeys = new Set<string>();
  private readonly staticClassValue: string;
  private readonly staticStyleValue: string;

  constructor(private readonly element: Element | HTMLElement) {
    this.staticClassValue = this.element.getAttribute('class') ?? '';
    this.staticStyleValue = this.element.getAttribute('style') ?? '';
  }

  write(props: Record<string, unknown>): void {
    const nextPropKeys = new Set<string>();
    for (const [name, value] of Object.entries(props)) {
      if (name === 'children' || name === '__lania_events' || name === '__lania_directives') {
        // 这些字段不直接落成普通 DOM prop/attr，而是走专门的 children/事件/指令通道。
        continue;
      }

      nextPropKeys.add(name);
      if (name === 'class') {
        writeClassAttribute(this.element, value, this.staticClassValue);
        continue;
      }

      if (name === 'style') {
        writeStyleAttribute(this.element, value, this.staticStyleValue);
        continue;
      }

      if (name in (this.element as unknown as Record<string, unknown>)) {
        writeComponentProp(this.element, name, value);
        continue;
      }

      setDynamicAttribute(this.element, name, value);
    }

    this.previousPropKeys.forEach((name) => {
      if (nextPropKeys.has(name)) {
        return;
      }

      if (name === 'class') {
        writeClassAttribute(this.element, null, this.staticClassValue);
        return;
      }

      if (name === 'style') {
        writeStyleAttribute(this.element, null, this.staticStyleValue);
        return;
      }

      if (name in (this.element as unknown as Record<string, unknown>)) {
        writeComponentProp(
          this.element,
          name,
          Object.prototype.hasOwnProperty.call(FAST_DOM_PROPERTY_RESET_VALUES, name)
            ? FAST_DOM_PROPERTY_RESET_VALUES[name]
            : undefined
        );
        return;
      }

      this.element.removeAttribute(name);
    });
    this.previousPropKeys = nextPropKeys;

    // 动态事件和指令集合也需要做 keyed diff，避免每次整批销毁重建。
    const eventBindings = readDynamicEvents(props);
    const nextEventKeys = new Set<string>();
    eventBindings.forEach((binding, bindingIndex) => {
      const key = `${binding.name}:${binding.modifiers.join('.')}:${JSON.stringify(binding.listener ?? {})}`;
      nextEventKeys.add(key);
      let slot = this.eventSlots.get(key);
      if (!slot) {
        slot = new EventSlot(
          this.element as EventTarget,
          binding.name,
          bindingIndex,
          binding.listener
        );
        this.eventSlots.set(key, slot);
      }

      const handler =
        typeof binding.handler === 'function'
          ? withEventModifiers(binding.handler as (event: Event) => unknown, binding.modifiers)
          : null;
      slot.write(handler);
    });
    this.eventSlots.forEach((slot, key) => {
      if (!nextEventKeys.has(key)) {
        slot.destroy();
        this.eventSlots.delete(key);
      }
    });

    const directiveBindings = readDynamicDirectives(props);
    const nextDirectiveKeys = new Set<string>();
    directiveBindings.forEach((binding, bindingIndex) => {
      const key = `${binding.kind}:${binding.name}`;
      nextDirectiveKeys.add(key);
      let slot = this.directiveSlots.get(key);
      if (!slot) {
        slot = createDirectiveSlotForBinding(this.element as HTMLElement, binding, bindingIndex);
        this.directiveSlots.set(key, slot);
      }

      slot.write(
        binding.kind === 'use'
          ? {
              name: binding.name,
              value: binding.value,
            }
          : binding.value
      );
    });
    this.directiveSlots.forEach((slot, key) => {
      if (!nextDirectiveKeys.has(key)) {
        slot.destroy();
        this.directiveSlots.delete(key);
      }
    });
  }

  destroy(): void {
    // destroy 时不仅要清掉动态事件/指令，还要把本轮写入过的 prop/attr 恢复干净。
    this.eventSlots.forEach((slot) => slot.destroy());
    this.eventSlots.clear();
    this.directiveSlots.forEach((slot) => slot.destroy());
    this.directiveSlots.clear();
    this.previousPropKeys.forEach((name) => {
      if (name === 'class') {
        writeClassAttribute(this.element, null, this.staticClassValue);
        return;
      }

      if (name === 'style') {
        writeStyleAttribute(this.element, null, this.staticStyleValue);
        return;
      }

      if (name in (this.element as unknown as Record<string, unknown>)) {
        writeComponentProp(
          this.element,
          name,
          Object.prototype.hasOwnProperty.call(FAST_DOM_PROPERTY_RESET_VALUES, name)
            ? FAST_DOM_PROPERTY_RESET_VALUES[name]
            : undefined
        );
        return;
      }

      this.element.removeAttribute(name);
    });
    this.previousPropKeys.clear();
  }
}

export class DynamicSlot implements Slot<DynamicSlotValue | null | undefined> {
  readonly type = 'dynamic';
  readonly frequency = 'normal';
  private mountedNodes: Node[] | null = acquireSlotNodeBuffer();
  private currentChildInstance: MountedBindingInstance | null = null;
  private currentComponent: unknown;
  private currentElementController: DynamicElementBindingController | null = null;
  private currentElementRoot: Element | HTMLElement | null = null;

  constructor(
    public readonly node: Comment,
    private readonly childTemplate: StaticTemplate,
    public readonly index: number
  ) {}

  // `mountedNodes` 通过缓冲池复用，减少频繁创建/销毁数组带来的 GC 压力。
  private ensureMountedNodes(): Node[] {
    this.mountedNodes ??= acquireSlotNodeBuffer();
    return this.mountedNodes;
  }

  hydrate(nodes: readonly Node[]): void {
    // hydration 阶段只记录 SSR 现有节点，真正接管逻辑延后到首次 write。
    this.ensureMountedNodes().push(...nodes);
  }

  private ensureChildInstance(
    bindings: readonly TemplateBindingPayload[] = [],
    hydratedNodesOverride?: readonly Node[]
  ): MountedBindingInstance {
    if (!this.currentChildInstance) {
      const hydratedNodes =
        hydratedNodesOverride !== undefined
          ? [...hydratedNodesOverride]
          : (this.mountedNodes?.filter((node) => node.parentNode !== null) ?? []);
      this.currentChildInstance =
        hydratedNodes.length > 0
          // 有可复用节点时优先走 hydrated binding，避免把 SSR 子树整棵重建。
          ? mountHydratedBinding(hydratedNodes, this.childTemplate, bindings)
          : mountTemplateBinding(this.childTemplate, bindings);
      return this.currentChildInstance;
    }

    this.currentChildInstance.update();
    return this.currentChildInstance;
  }

  private mountElementRoot(
    element: Element | HTMLElement,
    props: Record<string, unknown>,
    childBindings: readonly TemplateBindingPayload[]
  ): Node[] {
    // 原生元素或可实例化的自定义元素最终都会统一走“元素根 + 子模板 + 控制器”路径。
    this.currentElementController = new DynamicElementBindingController(element);
    this.currentElementController.write(props);
    const childInstance = this.ensureChildInstance(childBindings);
    appendDynamicChildren(element, childInstance.nodes);
    this.currentElementRoot = element;
    return [element];
  }

  private resolveMountedNodes(value: DynamicSlotValue): Node[] {
    const props = value.props ?? {};
    const target = resolveDynamicTarget(value.component);
    const childBindings = value.__lania_dynamic === 'block' ? (value.childBindings ?? []) : [];
    const hydratedNodes = this.mountedNodes?.filter((node) => node.parentNode !== null) ?? [];

    if (typeof target === 'string' && target.trim().length > 0) {
      // 字符串目标视为原生标签名。
      return this.mountElementRoot(document.createElement(target), props, childBindings);
    }

    if (target instanceof Element) {
      // 直接传入的现成 Element 也可以作为动态根复用。
      return this.mountElementRoot(target, props, childBindings);
    }

    if (isComponentElementConstructor(target)) {
      const scopedSlotChild = resolveScopedSlotChild(childBindings);
      const resolvedProps =
        scopedSlotChild === undefined
          ? props
          : { ...props, children: scopedSlotChild };
      const resolvedChildBindings =
        scopedSlotChild === undefined ? childBindings : [];
      const tagName = getComponentTagName(target);
      if (tagName) {
        try {
          return this.mountElementRoot(
            createComponentElement(target, { props: resolvedProps }),
            resolvedProps,
            resolvedChildBindings
          );
        } catch {
          // 组件宿主创建可能因为标签名非法或定义时序问题失败，此时继续尝试实例化回退路径。
        }
      }

      try {
        return this.mountElementRoot(
          new target(),
          resolvedProps,
          resolvedChildBindings
        );
      } catch {
        return [];
      }
    }

    if (typeof target === 'function') {
      const isEnhanced = isEnhancedDef(target);
      const scopedSlotChild = isEnhanced
        ? undefined
        : resolveScopedSlotChild(childBindings);
      const effectiveProps =
        scopedSlotChild === undefined
          ? props
          : { ...props, children: scopedSlotChild };
      const effectiveChildBindings =
        scopedSlotChild === undefined ? childBindings : [];
      const needsStructuralAnchors =
        isEnhanced &&
        ((target as { displayName?: string }).displayName === 'TransitionGroup');
      const hydratedTransitionGroupChildNodes =
        needsStructuralAnchors &&
        this.currentChildInstance === null &&
        hydratedNodes.length > 0
          ? bootstrapHydratedTransitionGroupDomHostState({
              props: effectiveProps,
              hydratedNodes,
            })
          : undefined;
      const needsTransitionBranchNodes =
        isEnhanced &&
        ((target as { displayName?: string }).displayName === 'Transition');
      const needsChildInstance =
        scopedSlotChild === undefined &&
        (isEnhanced ||
          effectiveChildBindings.length > 0 ||
          effectiveProps.children === undefined);
      const childInstance = needsChildInstance
        ? (needsStructuralAnchors
          ? this.currentChildInstance
          : this.ensureChildInstance(effectiveChildBindings))
        : null;
      const resolveStructuralChildren = () =>
        this.ensureChildInstance(
          effectiveChildBindings,
          hydratedTransitionGroupChildNodes
        ).nodes;
      const resolvedChildren =
        scopedSlotChild !== undefined
          ? scopedSlotChild
          : needsStructuralAnchors && needsChildInstance
            ? resolveStructuralChildren
            : childInstance
              ? (needsStructuralAnchors
                // TransitionGroup dom-host 模式需要保留原始结构锚点
                // （注释节点、模板边界节点等），而不只是“当前看得见的节点”。
                // 否则一旦 slot 锚点脱离，dom-host redirect 就无法重新建立。
                ? childInstance.nodes
                : needsTransitionBranchNodes
                  ? readTransitionChildNodes(childInstance)
                  : isEnhanced
                    ? resolveEnhancedDynamicChildren(
                        effectiveChildBindings,
                        childInstance,
                        effectiveProps.children
                      )
                    : readMountedNodes(childInstance))
              : effectiveProps.children;
      const invokeTarget = () =>
        withRuntimeScope(
          {
            slotContent: resolvedChildren,
          },
          () =>
            (target as (props: Record<string, unknown>) => unknown)({
              ...effectiveProps,
              children: resolvedChildren,
            })
        );
      const result = normalizeDynamicResult(
        // 增强组件在执行时需要挂上延迟 transition hook 包装。
        isEnhanced ? withDeferredTransitionHooks(invokeTarget) : invokeTarget()
      );
      if (isEnhanced && result.length === 0 && hydratedNodes.length > 0) {
        // 某些增强组件首次 hydration 可能暂时不产出新节点，此时保留 SSR 现有节点，
        // 等它们后续真正拿到运行时状态后再决定是否替换。
        return hydratedNodes;
      }
      if (!isEnhanced && result.length === 1 && result[0] instanceof Element) {
        this.currentElementRoot = result[0];
        this.currentElementController = new DynamicElementBindingController(result[0]);
        this.currentElementController.write(effectiveProps);
      }
      return result;
    }

    return [];
  }

  private canReuseMountedValue(value: DynamicSlotValue): boolean {
    const target = resolveDynamicTarget(value.component);
    if (!this.mountedNodes || this.mountedNodes.length === 0) {
      return false;
    }

    if (typeof target === 'string') {
      return this.currentComponent === target && this.currentElementRoot instanceof HTMLElement;
    }

    if (target instanceof Element) {
      return this.currentComponent === target && this.currentElementRoot === target;
    }

    if (isComponentElementConstructor(target)) {
      return this.currentComponent === target && this.currentElementRoot instanceof target;
    }

    if (typeof target === 'function') {
      // 普通函数组件只有在当前结果稳定落成单个 Element 且仍由控制器接管时才可就地复用。
      return (
        !isEnhancedDef(target) &&
        this.currentComponent === target &&
        this.currentElementRoot instanceof Element &&
        this.currentElementController !== null
      );
    }

    return false;
  }

  write(value: DynamicSlotValue | null | undefined): void {
    const parent = this.node.parentNode;

    if (!parent || !value) {
      this.destroy();
      return;
    }

    const normalizedValue =
      resolveDynamicTarget(value.component) === value.component
        ? value
        : {
            ...value,
            component: resolveDynamicTarget(value.component),
          };

    const childBindings =
      normalizedValue.__lania_dynamic === 'block' ? (normalizedValue.childBindings ?? []) : [];
    const isStructuralTransitionGroup = isTransitionGroupTarget(normalizedValue.component);

    if (
      typeof normalizedValue.component === 'function' &&
      isEnhancedDef(normalizedValue.component) &&
      this.currentComponent === normalizedValue.component &&
      this.mountedNodes
    ) {
      // 同一个增强组件类型重复写入时，优先走节点 reconcile，而不是整段销毁重挂。
      const currentNodes = [...this.mountedNodes];
      const nextNodes = this.resolveMountedNodes(normalizedValue);
      reconcileNodesBeforeAnchor(parent, this.node, currentNodes, nextNodes);
      this.currentComponent = normalizedValue.component;
      this.currentElementRoot = null;
      this.currentElementController = null;
      this.currentChildInstance?.update();
      this.mountedNodes.length = 0;
      this.mountedNodes.push(...nextNodes);
      return;
    }

    if (
      this.canReuseMountedValue(normalizedValue) &&
      this.currentElementRoot &&
      this.currentElementController
    ) {
      // 对可复用的元素根，只更新 props 和子绑定，不重新创建 DOM。
      this.currentElementController.write(normalizedValue.props ?? {});
      this.ensureChildInstance(childBindings).update();
      return;
    }

    // 首次 hydrated 写入时，增强组件往往已经通过 `mountedNodes` 接管了一整段 SSR 子树。
    // 这里优先对现有子树做 reconcile，而不是先整体 destroy 再重挂，以保住外层包装节点身份。
    if (
      typeof normalizedValue.component === 'function' &&
      isEnhancedDef(normalizedValue.component) &&
      this.currentComponent == null &&
      this.mountedNodes &&
      this.mountedNodes.some((node) => node.parentNode !== null)
    ) {
      if (isStructuralTransitionGroup) {
        // TransitionGroup 的结构锚点在 hydration 首次接管时必须完整保留。
        this.resolveMountedNodes(normalizedValue);
        this.currentComponent = normalizedValue.component;
        this.currentElementRoot = null;
        this.currentElementController = null;
        this.currentChildInstance?.update();
        return;
      }
      const currentNodes = [...this.mountedNodes];
      const nextNodes = this.resolveMountedNodes(normalizedValue);
      reconcileNodesBeforeAnchor(parent, this.node, currentNodes, nextNodes);
      this.currentComponent = normalizedValue.component;
      this.currentElementRoot = null;
      this.currentElementController = null;
      this.currentChildInstance?.update();
      this.mountedNodes.length = 0;
      this.mountedNodes.push(...nextNodes);
      return;
    }

    this.destroy();
    this.currentComponent = normalizedValue.component;
    const mountedNodes = this.ensureMountedNodes();
    mountedNodes.push(...this.resolveMountedNodes(normalizedValue));
    appendNodesBeforeAnchor(parent, this.node, mountedNodes);
  }

  destroy(): void {
    // destroy 既要清理 DOM，也要释放子实例与数组缓冲池，避免残留引用。
    this.currentElementController?.destroy();
    this.currentElementController = null;
    this.currentElementRoot = null;
    this.currentComponent = null;
    this.currentChildInstance?.destroy();
    this.currentChildInstance = null;
    if (!this.mountedNodes) {
      return;
    }

    removeNodes(this.mountedNodes);
    releaseSlotNodeBuffer(this.mountedNodes);
    this.mountedNodes = null;
  }
}
