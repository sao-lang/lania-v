/**
 * 处理组件插槽位在真实 DOM 中的挂载与动态绑定同步。
 *
 * 组件 slot 会延迟创建宿主元素，并把事件/指令绑定拆成可复用的子 slot。
 */
import { withEventModifiers } from '../../../component/events';
import {
  createComponentElement,
  isComponentElementConstructor,
  type ComponentElementConstructor,
} from '../../../component/host/function-component';
import { readRefExposed, setRef, type RefBinding } from '../../ref';
import { EventSlot, type Slot, writeComponentProp } from '../core';
import {
  createDirectiveSlotForBinding,
  readDynamicDirectives,
  readDynamicEvents,
  type DynamicDirectiveBinding,
} from './directive-slots';

const readComponentRefBinding = (
  props: Record<string, unknown>
): DynamicDirectiveBinding | null => {
  return readDynamicDirectives(props).find((binding) => binding.kind === 'ref') ?? null;
};

type ComponentSlotValue<TProps extends Record<string, unknown> = Record<string, unknown>> =
  | TProps
  | null
  | undefined;

type ComponentSlotTarget<TElement extends HTMLElement> =
  | string
  | ComponentElementConstructor<TElement>
  | (() => TElement);

export class ComponentSlot<
  TElement extends HTMLElement,
  TProps extends Record<string, unknown> = Record<string, unknown>
> implements Slot<ComponentSlotValue<TProps>> {
  readonly type = 'component';
  readonly frequency = 'normal';
  public readonly node: Comment;
  instance: TElement | null = null;
  private eventSlots = new Map<string, EventSlot>();
  private directiveSlots = new Map<string, Slot<unknown>>();
  private currentRef: RefBinding<unknown> | null = null;

  constructor(
    anchor: Comment,
    private readonly target: ComponentSlotTarget<TElement>,
    public readonly index: number
  ) {
    this.node = anchor;
  }

  // 目标既可能是原生标签，也可能是自定义元素构造器或工厂函数。
  private createElement(props?: Record<string, unknown>): TElement {
    if (typeof this.target === 'string') {
      return document.createElement(this.target) as TElement;
    }

    if (isComponentElementConstructor(this.target)) {
      return createComponentElement(
        this.target,
        props ? { props } : {}
      ) as TElement;
    }

    return this.target();
  }

  // 写入时只创建一次实例，后续增量同步普通 props、事件和指令。
  write(value: ComponentSlotValue<TProps>): void {
    if (!value) {
      return;
    }

    const props = value as Record<string, unknown>;

    if (!this.instance) {
      // 组件 ref 需要以 prop 形式进入子组件，`createExpose()` 才能读到并回写暴露面。
      const initialRef = readComponentRefBinding(props);
      if (initialRef) {
        props.ref = initialRef.value;
      }

      // 首次创建时把 props 一并传入，让组件在字段初始化阶段就能读到真实 props。
      this.instance = this.createElement(props);
      this.node.parentNode?.insertBefore(this.instance, this.node);
    }

    const eventBindings = readDynamicEvents(props);
    const directiveBindings = readDynamicDirectives(props);
    const refBinding = directiveBindings.find((binding) => binding.kind === 'ref') ?? null;

    for (const [key, propValue] of Object.entries(props)) {
      if (key === '__lania_events' || key === '__lania_directives' || key === 'ref') {
        continue;
      }

      writeComponentProp(this.instance, key, propValue);
    }

    const nextEventKeys = new Set<string>();
    eventBindings.forEach((binding, bindingIndex) => {
      const key = `${binding.name}:${binding.modifiers.join('.')}:${JSON.stringify(binding.listener ?? {})}`;
      nextEventKeys.add(key);
      let slot = this.eventSlots.get(key);

      if (!slot) {
        slot = new EventSlot(
          this.instance as EventTarget,
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

    // 当前轮没有出现的动态事件需要显式销毁，避免旧监听器泄漏。
    this.eventSlots.forEach((slot, key) => {
      if (!nextEventKeys.has(key)) {
        slot.destroy();
        this.eventSlots.delete(key);
      }
    });

    const nextDirectiveKeys = new Set<string>();
    directiveBindings.forEach((binding, bindingIndex) => {
      if (binding.kind === 'ref') {
        // 组件 ref 的写入目标是暴露面或宿主实例，不走 RefSlot（它只会写节点本身）。
        return;
      }

      const key = `${binding.kind}:${binding.name}`;
      nextDirectiveKeys.add(key);
      let slot = this.directiveSlots.get(key);

      if (!slot) {
        slot = createDirectiveSlotForBinding(this.instance as HTMLElement, binding, bindingIndex);
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

    // 指令绑定同样按 key 做增量淘汰，保持与最新 props 对齐。
    this.directiveSlots.forEach((slot, key) => {
      if (!nextDirectiveKeys.has(key)) {
        slot.destroy();
        this.directiveSlots.delete(key);
      }
    });

    if (refBinding) {
      const refValue = (refBinding.value as RefBinding<unknown> | null | undefined) ?? null;
      this.currentRef = refValue;

      if (refValue) {
        // 子组件调用过 `createExpose()` 时回写暴露面，否则退回宿主元素。
        const exposed = readRefExposed(refValue);
        setRef(refValue, (exposed ?? this.instance) as unknown);
      }
    }
  }

  destroy(): void {
    this.eventSlots.forEach((slot) => slot.destroy());
    this.eventSlots.clear();
    this.directiveSlots.forEach((slot) => slot.destroy());
    this.directiveSlots.clear();
    if (this.currentRef) {
      setRef(this.currentRef, null);
      this.currentRef = null;
    }
    this.instance?.remove();
    this.instance = null;
  }
}
