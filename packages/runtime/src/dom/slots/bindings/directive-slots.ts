/**
 * 解析动态事件/指令绑定，并为它们创建具体的 slot 实现。
 *
 * 这层处在“编译产物属性对象”与“真实 DOM 写入通道”之间：
 * - 编译期会把动态事件收敛到 `__lania_events`；
 * - 动态指令会收敛到 `__lania_directives`；
 * - 运行时再按 `kind` 拆成 bind/model/html/class/style/use/ref 等 slot。
 *
 * 这样做的目的，是把模板生成阶段的统一描述，延后到这里再映射成
 * 更贴近平台行为的写入实现，避免在编译期提前绑定过多 DOM 细节。
 *
 * 因而本文件更像一个“绑定解释层”：
 * - 上游只需要给出标准化 binding 记录；
 * - 这里决定要落到普通 attribute、property、directive lifecycle 还是 ref/model 通道；
 * - keepalive 保活、动态指令定义和旧格式兼容也都在这一层被吸收。
 */
import { type EventModifier } from '../../../component/events';
import {
  applyBoundValue,
  createModelEventHandler,
  DirectiveSlot as RawDirectiveSlot,
  type DirectiveDef,
  type ModelBinding,
  type ModelModifier,
  normalizeModelValue,
  parseModelDebounceModifier,
  readModelDebounceMs,
  readModelModifiers,
  resolveDirective,
} from '../../directives';
import { applyHtml } from '../../html-value';
import { queueRefWrite, type RefBinding } from '../../ref';
import { warning } from '../../../core/debug';
import {
  ClassSlot,
  EventSlot,
  FAST_DOM_PROPERTY_RESET_VALUES,
  StyleSlot,
  type Slot,
} from '../core';
import type { RetainedSlotLifecycle } from '../template/template-types';

export interface DynamicEventBinding {
  name: string;
  handler: unknown;
  modifiers: readonly EventModifier[];
  listener?: {
    once?: boolean;
    capture?: boolean;
    passive?: boolean;
  };
  /** 提示性修饰符（`debounce` / `throttle`），运行时据此额外包装处理器。 */
  hints?: readonly string[];
}

export interface DynamicDirectiveBinding {
  kind:
    | 'bind'
    | 'model'
    | 'html'
    | 'class'
    | 'style'
    | 'use'
    | 'ref'
    | 'unknown'
    | 'if';
  name: string;
  value: unknown;
  modifiers: readonly string[];
  unit?: string;
}

export interface UseDirectiveBindingValue {
  name: string;
  value: unknown;
}

const looksLikeDirectiveDef = (
  value: unknown
): value is DirectiveDef<unknown, HTMLElement> => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as {
    mounted?: unknown;
    updated?: unknown;
    unmounted?: unknown;
  };

  return (
    typeof candidate.mounted === 'function' ||
    typeof candidate.updated === 'function' ||
    typeof candidate.unmounted === 'function'
  );
};

// 编译期约定的动态事件数组挂在私有字段上，运行时这里只做安全读取。
export const readDynamicEvents = (
  props: Record<string, unknown>
): DynamicEventBinding[] => {
  const value = props.__lania_events;
  return Array.isArray(value) ? (value as DynamicEventBinding[]) : [];
};

export const readDynamicDirectives = (
  props: Record<string, unknown>
): DynamicDirectiveBinding[] => {
  const value = props.__lania_directives;
  // 与动态事件同理，私有字段只作为编译产物到运行时之间的内部协议，不暴露额外解析语义。
  return Array.isArray(value) ? (value as DynamicDirectiveBinding[]) : [];
};

// 根据 binding.kind 选择最合适的 slot 实现。
// 这里是“描述层 -> 具体写通道”的分发表，未知类型退回普通属性绑定。
export const createDirectiveSlotForBinding = (
  element: HTMLElement,
  binding: DynamicDirectiveBinding,
  index: number
): Slot<unknown> => {
  switch (binding.kind) {
    case 'bind':
      return new DirectiveBindingSlot(element, binding.name, index);
    case 'model':
      return new ModelBindingSlot(
        element,
        binding.name || 'value',
        index,
        binding.modifiers as readonly ModelModifier[]
      );
    case 'html':
    case 'unknown':
      return new DirectiveBindingSlot(element, binding.name, index);
    case 'class':
      return new ClassSlot(element, binding.name, index);
    case 'style':
      return new StyleSlot(element, binding.name, index, binding.unit ?? '');
    case 'use':
      return new UseDirectiveSlot(element, index);
    case 'ref':
      return new RefSlot(element, index);
    default:
      return new DirectiveBindingSlot(element, binding.name, index);
  }
};

// `use` 指令支持 keepalive 保活，因此额外实现 retained lifecycle。
export class UseDirectiveSlot implements Slot<unknown>, RetainedSlotLifecycle {
  readonly type = 'directive';
  readonly frequency = 'normal';
  private inner: RawDirectiveSlot<unknown, HTMLElement> | null = null;
  private currentBinding: UseDirectiveBindingValue | null = null;
  private currentDef: DirectiveDef<unknown, HTMLElement> | null = null;
  private active = true;

  constructor(
    public readonly node: HTMLElement,
    public readonly index: number
  ) {}

  write(value: unknown): void {
    const binding = this.normalizeBinding(value);
    if (!binding) {
      // 绑定被移除时直接销毁内部 directive slot，避免旧副作用继续残留。
      this.inner?.destroy();
      this.inner = null;
      this.currentBinding = null;
      this.currentDef = null;
      return;
    }

    if (!this.active) {
      // keepalive 失活期间只缓存最新 binding，等重新激活时再真正挂载。
      this.currentBinding = binding;
      this.currentDef = this.resolveDefinition(binding);
      return;
    }

    const nextDef = this.resolveDefinition(binding);
    const definitionChanged = this.currentDef !== nextDef;
    this.currentBinding = binding;
    this.currentDef = nextDef;

    if (!this.currentDef) {
      if (binding.name.length > 0) {
        warning(`Directive "${binding.name}" is not registered.`, false);
      }
      this.inner?.destroy();
      this.inner = null;
      return;
    }

    if (definitionChanged) {
      this.inner?.destroy();
      this.inner = new RawDirectiveSlot(this.node, this.currentDef, this.index);
    }

    if (!this.inner) {
      return;
    }

    this.inner.write(binding.value);
  }

  activate(): void {
    if (this.active) {
      return;
    }

    this.active = true;
    if (!this.currentBinding) {
      return;
    }

    this.write(this.currentBinding);
  }

  deactivate(): void {
    if (!this.active) {
      return;
    }

    this.active = false;
    if (this.inner) {
      this.inner.destroy();
      this.inner = null;
    }
  }

  destroy(): void {
    if (this.inner) {
      this.inner.destroy();
    }
    this.inner = null;
    this.currentBinding = null;
    this.currentDef = null;
    this.active = false;
  }

  private normalizeBinding(value: unknown): UseDirectiveBindingValue | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    if ('name' in value) {
      const binding = value as { name?: unknown; value?: unknown };
      if (typeof binding.name === 'string' && binding.name.length > 0) {
        return {
          name: binding.name,
          value: binding.value,
        };
      }
    }

    // 兼容旧格式：直接把内联 DirectiveDef 当作 value 传入。
    return {
      name: '',
      value,
    };
  }

  private resolveDefinition(
    binding: UseDirectiveBindingValue
  ): DirectiveDef<unknown, HTMLElement> | null {
    // 允许调用方直接把 DirectiveDef 内联传入，而不是总是先注册再按名字解析。
    if (looksLikeDirectiveDef(binding.value)) {
      return binding.value;
    }

    if (binding.name.length > 0) {
      return resolveDirective(binding.name) ?? null;
    }

    if (binding.value && typeof binding.value === 'object') {
      warning(
        'Inline use directive definition is invalid. Expected a DirectiveDef with mounted/updated/unmounted handlers.',
        false
      );
    }

    return null;
  }
}

// `model` 绑定会同时维护值写入和事件回写两个子通道。
export class ModelBindingSlot implements Slot<unknown> {
  readonly type = 'directive';
  readonly frequency = 'normal';
  private readonly valueSlot: DirectiveBindingSlot;
  private eventSlot: EventSlot | null = null;
  private currentEventName: string | null = null;
  private currentModelSetter: ((next: unknown) => unknown) | null = null;
  private currentModelProp: string | null = null;
  private currentModelModifiers: readonly ModelModifier[] = [];
  private currentModelHandler: EventListener | null = null;
  private currentModelDebounceMs: number | undefined;

  constructor(
    public readonly node: HTMLElement,
    private readonly name: string,
    public readonly index: number,
    private readonly modifiers: readonly ModelModifier[] = []
  ) {
    this.valueSlot = new DirectiveBindingSlot(node, name, index);
  }

  write(value: unknown): void {
    const normalized = this.normalizeBinding(value);
    if (normalized) {
      // model 命中双向绑定协议时，同时接管“值写入”和“事件回写”。
      this.valueSlot.write(normalized.get());
      this.syncEventSlot(
        normalized.eventName,
        this.getModelEventHandler(normalized)
      );
      return;
    }

    this.valueSlot.write(value);
    this.syncEventSlot(null, null);
  }

  destroy(): void {
    this.valueSlot.destroy();
    this.eventSlot?.destroy();
    this.eventSlot = null;
    this.currentEventName = null;
    this.currentModelSetter = null;
    this.currentModelProp = null;
    this.currentModelModifiers = [];
    this.currentModelHandler = null;
  }

  private syncEventSlot(
    eventName: string | null,
    handler: EventListener | null
  ): void {
    if (!eventName) {
      // 不再需要事件回写时，及时拆掉旧监听。
      this.eventSlot?.destroy();
      this.eventSlot = null;
      this.currentEventName = null;
      return;
    }

    if (!this.eventSlot || this.currentEventName !== eventName) {
      this.eventSlot?.destroy();
      this.eventSlot = new EventSlot(this.node, eventName, this.index);
      this.currentEventName = eventName;
    }

    this.eventSlot.write(handler);
  }

  private normalizeBinding(value: unknown): {
    get: () => unknown;
    set: (next: unknown) => unknown;
    prop: string;
    modifiers: readonly ModelModifier[];
    debounceMs?: number;
    eventName: string;
  } | null {
    // 兼容 signal 直接作为 model 值传入的简写形式。
    if (typeof value === 'function' && 'set' in value) {
      const signal = value as (() => unknown) & { set(next: unknown): unknown };
      const eventName = this.resolveEventName(this.name, this.modifiers);
      return {
        get: signal,
        set: signal.set,
        prop: this.name,
        modifiers: this.modifiers,
        debounceMs: parseModelDebounceModifier(this.modifiers),
        eventName,
      };
    }

    // `createSignal()` 返回 `{ value, set }` 对象，语义同样可读写。
    if (
      value !== null &&
      typeof value === 'object' &&
      'value' in value &&
      typeof (value as { set?: unknown }).set === 'function'
    ) {
      const holder = value as {
        readonly value: unknown;
        set: (next: unknown) => unknown;
      };
      const eventName = this.resolveEventName(this.name, this.modifiers);
      return {
        get: () => holder.value,
        set: (next) => holder.set(next),
        prop: this.name,
        modifiers: this.modifiers,
        debounceMs: parseModelDebounceModifier(this.modifiers),
        eventName,
      };
    }

    if (!value || typeof value !== 'object') {
      return null;
    }

    const binding = value as ModelBinding;
    const prop = binding.prop ?? this.name;
    const modifiers = readModelModifiers(binding);
    // 运行时修饰符优先读 binding 自带配置；没有时再回退到编译期静态 modifiers。
    const mergedModifiers =
      modifiers.length > 0 ? modifiers : [...this.modifiers];
    // 运行时没显式配置时，回退到编译期静态的 `debounceMs`。
    const debounceMs =
      readModelDebounceMs(binding) ??
      parseModelDebounceModifier(mergedModifiers);
    const eventName = this.resolveEventName(prop, mergedModifiers);

    if (
      'target' in binding &&
      typeof binding.target === 'function' &&
      'set' in binding.target
    ) {
      return {
        get: binding.target,
        set: binding.target.set,
        prop,
        modifiers: mergedModifiers,
        debounceMs,
        eventName,
      };
    }

    // `createSignal()` 返回 `{ value, set }` 对象而不是可调用函数，
    // 但语义上同样是「可读可写的 target」，因此这里一并接受。
    if (
      'target' in binding &&
      binding.target !== null &&
      typeof binding.target === 'object' &&
      'value' in binding.target &&
      typeof (binding.target as { set?: unknown }).set === 'function'
    ) {
      const holder = binding.target as {
        readonly value: unknown;
        set: (next: unknown) => unknown;
      };

      return {
        get: () => holder.value,
        set: (next) => holder.set(next),
        prop,
        modifiers: mergedModifiers,
        debounceMs,
        eventName,
      };
    }

    if (
      'source' in binding &&
      binding.source &&
      typeof binding.source.get === 'function' &&
      typeof binding.source.set === 'function'
    ) {
      return {
        get: binding.source.get,
        set: binding.source.set,
        prop,
        modifiers: mergedModifiers,
        debounceMs,
        eventName,
      };
    }

    return null;
  }

  /** 由最终 prop 与修饰符推导监听事件：`checked` / `lazy` 用 `change`，其余用 `input`。 */
  private resolveEventName(
    prop: string,
    modifiers: readonly ModelModifier[]
  ): string {
    return prop === 'checked' || modifiers.includes('lazy')
      ? 'change'
      : 'input';
  }

  private getModelEventHandler(binding: {
    set: (next: unknown) => unknown;
    prop: string;
    modifiers: readonly ModelModifier[];
    debounceMs?: number;
  }): EventListener {
    if (
      this.currentModelHandler &&
      this.currentModelSetter === binding.set &&
      this.currentModelProp === binding.prop &&
      this.currentModelDebounceMs === binding.debounceMs &&
      sameModelModifiers(this.currentModelModifiers, binding.modifiers)
    ) {
      return this.currentModelHandler;
    }

    this.currentModelSetter = binding.set;
    this.currentModelProp = binding.prop;
    this.currentModelModifiers = binding.modifiers;
    this.currentModelDebounceMs = binding.debounceMs;
    this.currentModelHandler = createModelEventHandler(
      { set: binding.set },
      binding.modifiers,
      binding.prop,
      { debounceMs: binding.debounceMs }
    );
    return this.currentModelHandler;
  }
}

const sameModelModifiers = (
  left: readonly ModelModifier[],
  right: readonly ModelModifier[]
): boolean => {
  if (left === right) {
    return true;
  }

  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
};

export class DirectiveBindingSlot implements Slot<unknown> {
  readonly type = 'directive';
  readonly frequency = 'normal';

  constructor(
    public readonly node: Element | HTMLElement,
    public readonly name: string,
    public readonly index: number
  ) {}

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

    // 对常见 DOM property 走 property 写入，可同步保留 attribute 的清理语义。
    applyBoundValue(
      this.node,
      this.name,
      value == null || value === false ? resetValue : value
    );
    if (value == null || value === false) {
      this.node.removeAttribute(this.name);
    }
    return true;
  }

  write(value: unknown): void {
    if (this.writeFastDomProperty(value)) {
      return;
    }

    switch (this.name) {
      case 'bind':
        // `bind`/`model` 在退化路径下统一回写到 value。
        applyBoundValue(this.node as HTMLElement, 'value', value);
        return;
      case 'model':
        applyBoundValue(
          this.node as HTMLElement,
          'value',
          typeof value === 'string' ? normalizeModelValue(value, []) : value
        );
        return;
      case 'html':
        applyHtml(this.node as HTMLElement, value);
        return;
      default:
        if (value == null || value === false) {
          // 其余 attribute 沿用 HTML 语义：null/false 表示移除该属性。
          this.node.removeAttribute(this.name);
          return;
        }

        this.node.setAttribute(this.name, String(value));
    }
  }

  destroy(): void {
    if (this.name === 'html') {
      // `v-html` 风格绑定销毁时必须清空 innerHTML，而不是只删属性名。
      (this.node as HTMLElement).innerHTML = '';
      return;
    }

    if (this.writeFastDomProperty(null)) {
      return;
    }

    this.node.removeAttribute(this.name);
  }
}

export class RefSlot<T>
  implements Slot<RefBinding<T> | null | undefined>, RetainedSlotLifecycle
{
  readonly type = 'ref';
  readonly frequency = 'low';
  private currentRef: RefBinding<T> | null | undefined;
  private active = true;

  constructor(
    public readonly node: Node | Element | HTMLElement,
    public readonly index: number
  ) {}

  write(value: RefBinding<T> | null | undefined): void {
    if (this.currentRef && this.currentRef !== value && this.active) {
      // ref 目标切换时先把旧 ref 置空，保持常见框架一致的解绑时序。
      queueRefWrite(this.currentRef, null);
    }

    this.currentRef = value;
    if (this.active) {
      queueRefWrite(value, this.node as T);
    }
  }

  activate(): void {
    if (this.active) {
      return;
    }

    this.active = true;
    queueRefWrite(this.currentRef, this.node as T);
  }

  deactivate(): void {
    if (!this.active) {
      return;
    }

    queueRefWrite(this.currentRef, null);
    this.active = false;
  }

  destroy(): void {
    queueRefWrite(this.currentRef, null);
    this.currentRef = null;
    this.active = false;
  }
}
