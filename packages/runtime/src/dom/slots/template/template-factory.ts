/**
 * 模板绑定实例工厂。
 *
 * 该文件负责把编译阶段产出的 template binding 描述转换成可执行 slot 实例，并同时覆盖：
 * - 首次挂载场景：基于静态模板克隆 DOM，再为每条 binding 建立 slot；
 * - hydration 场景：基于现有节点恢复 slot，并把服务端输出与客户端绑定重新对齐；
 * - 生命周期转发：向上暴露统一的 `update / activate / deactivate / destroy` 接口。
 *
 * 它是“编译产物描述”与“运行时 slot 对象”之间的桥：
 * - `createTemplateSlot()` 负责把 binding.kind 分发到具体 slot 类；
 * - `writeTemplateBindingSlot()` 负责把 evaluate 结果写入 slot；
 * - `mountTemplateBinding()` / `mountHydratedBinding()` 分别处理纯客户端挂载与 hydration 接管。
 */
import type { MountedStaticTemplate, StaticTemplate } from '../../../render/types';
import {
  createHydratedTemplate,
  hasHydrationSlot,
  mountStaticTemplate,
  readHydrationSlotNodes,
  readTeleportNodes,
  resolveMountedTemplateNode,
  resolveSlotAnchor,
  resolveTextSlotNode,
} from '../../../render/dom';
import { withEventModifiers, type EventModifier } from '../../../component/events';
import type { ModelModifier } from '../../directives';
import {
  AttrSlot,
  ClassSlot,
  EventSlot,
  PropSlot,
  StyleSlot,
  TextSlot,
  type Slot,
} from '../core';
import { BoundarySlot, IfSlot, TeleportSlot } from '../boundary-slot';
import { DynamicSlot } from '../dynamic-slot';
import { ForSlot } from '../for-slot';
import { KeepAliveSlot } from '../keepalive-slot';
import {
  ModelBindingSlot,
  RefSlot,
  createDirectiveSlotForBinding,
} from '../bindings/directive-slots';
import type { MountedBindingInstance, RetainedSlotLifecycle, TemplateBindingPayload } from './template-types';

const createTemplateSlot = (
  mounted: MountedStaticTemplate,
  binding: TemplateBindingPayload,
  index: number
): Slot<unknown> => {
  // binding.kind 与具体 slot 实现一一对应，这里是模板运行时的分发表。
  switch (binding.kind) {
    case 'text':
      return new TextSlot(resolveTextSlotNode(mounted, binding.slotIndex, binding.path), index);
    case 'attr':
      return new AttrSlot(
        resolveMountedTemplateNode(mounted, binding.path) as Element,
        binding.name ?? '',
        index
      );
    case 'prop':
      return new PropSlot(
        resolveMountedTemplateNode(mounted, binding.path) as Element | HTMLElement,
        binding.name ?? '',
        index
      );
    case 'class':
      return new ClassSlot(
        resolveMountedTemplateNode(mounted, binding.path) as HTMLElement,
        binding.name ?? '',
        index
      );
    case 'style':
      return new StyleSlot(
        resolveMountedTemplateNode(mounted, binding.path) as HTMLElement,
        binding.name ?? '',
        index,
        binding.unit ?? ''
      );
    case 'event':
      return new EventSlot(
        resolveMountedTemplateNode(mounted, binding.path) as EventTarget,
        binding.name ?? 'click',
        index,
        binding.listener
      );
    case 'ref':
      return new RefSlot(resolveMountedTemplateNode(mounted, binding.path), index);
    case 'directive': {
      const node = resolveMountedTemplateNode(mounted, binding.path) as HTMLElement;
      if (binding.directiveKind === 'model') {
        // `v-model` 需要专用 slot，负责值回写与事件监听协作。
        return new ModelBindingSlot(
          node,
          binding.name ?? 'value',
          index,
          (binding.modifiers ?? []) as readonly ModelModifier[]
        );
      }

      return createDirectiveSlotForBinding(
        node,
        {
          kind: binding.directiveKind ?? 'unknown',
          name: binding.name ?? '',
          value: undefined,
          modifiers: [...(binding.modifiers ?? [])],
          unit: binding.unit,
        },
        index
      );
    }
    case 'for':
      // `for` slot 只拿锚点；具体条目模板实例在 ForSlot 内部按数据规模延迟创建。
      return new ForSlot(
        resolveSlotAnchor(mounted, binding.slotIndex, binding.path),
        index,
        binding.fallbackTemplate
          ? () => [...binding.fallbackTemplate!.clone().childNodes]
          : undefined
      );
    case 'if':
      return new IfSlot(
        resolveSlotAnchor(mounted, binding.slotIndex, binding.path),
        binding.template ?? { html: '', template: document.createElement('template'), clone: () => document.createDocumentFragment() },
        index,
        binding.fallbackTemplate
      );
    case 'dynamic':
      return new DynamicSlot(
        resolveSlotAnchor(mounted, binding.slotIndex, binding.path),
        binding.template ?? { html: '', template: document.createElement('template'), clone: () => document.createDocumentFragment() },
        index
      );
    case 'boundary':
      // boundary/teleport/keepalive 这类 slot 都依赖注释锚点维护一段独立区间。
      return new BoundarySlot(
        resolveSlotAnchor(mounted, binding.slotIndex, binding.path),
        binding.template ?? { html: '', template: document.createElement('template'), clone: () => document.createDocumentFragment() },
        index,
        binding.fallbackTemplate
      );
    case 'teleport':
      return new TeleportSlot(
        resolveSlotAnchor(mounted, binding.slotIndex, binding.path),
        binding.template ?? { html: '', template: document.createElement('template'), clone: () => document.createDocumentFragment() },
        index
      );
    case 'keepalive':
      return new KeepAliveSlot(
        resolveSlotAnchor(mounted, binding.slotIndex, binding.path),
        binding.template ?? { html: '', template: document.createElement('template'), clone: () => document.createDocumentFragment() },
        index
      );
    default:
      return new TextSlot(resolveTextSlotNode(mounted, binding.slotIndex, binding.path), index);
  }
};

const writeTemplateBindingSlot = (
  slot: Slot<unknown>,
  binding: TemplateBindingPayload,
  ...args: unknown[]
): unknown => {
  // evaluate 在这里统一执行，保证挂载与后续 update 走同一条写入路径。
  const nextValue = binding.evaluate(...args);

  if (binding.kind === 'event') {
    // 事件绑定先包一层 modifier 适配，再把最终 handler 写入 EventSlot。
    const handler =
      typeof nextValue === 'function'
        ? withEventModifiers(
            nextValue as (event: Event) => unknown,
            (binding.modifiers ?? []) as readonly EventModifier[]
          )
        : null;
    slot.write(handler);
    return nextValue;
  }

  if (binding.kind === 'directive' && binding.directiveKind === 'use') {
    // `use:` 指令写入的是指令名和值的组合对象，而不是 evaluate 的原始结果。
    slot.write({
      name: binding.name ?? '',
      value: nextValue,
    });
    return nextValue;
  }

  slot.write(nextValue);
  return nextValue;
};

export const mountTemplateBinding = (
  template: StaticTemplate,
  bindings: readonly TemplateBindingPayload[],
  ...args: unknown[]
): MountedBindingInstance => {
  const fragment = document.createDocumentFragment();
  // 先把静态模板完整克隆到 fragment，再基于 mounted 结果解析各个 slot 的节点位置。
  const mounted = mountStaticTemplate(fragment, template, { hydrate: false });
  const slots = bindings.map((binding, bindingIndex) =>
    createTemplateSlot(mounted, binding, binding.slotIndex >= 0 ? binding.slotIndex : bindingIndex)
  );
  const previousBindingValues: unknown[] = new Array(bindings.length);
  const hasPreviousBindingValue = new Array(bindings.length).fill(false);
  // 首次挂载后立刻执行一轮写入，让模板克隆结果与初始上下文同步。
  bindings.forEach((binding, bindingIndex) => {
    const slot = slots[bindingIndex];
    if (slot) {
      previousBindingValues[bindingIndex] = writeTemplateBindingSlot(slot, binding, ...args);
      hasPreviousBindingValue[bindingIndex] = true;
    }
  });

  return {
    fragment,
    nodes: [...fragment.childNodes],
    mounted,
    slots,
    update(...nextArgs: unknown[]) {
      bindings.forEach((binding, bindingIndex) => {
        const slot = slots[bindingIndex];
        if (slot) {
          const nextValue = binding.evaluate(...nextArgs);
          if (
            hasPreviousBindingValue[bindingIndex] &&
            Object.is(previousBindingValues[bindingIndex], nextValue)
          ) {
            return;
          }

          if (binding.kind === 'event') {
            const handler =
              typeof nextValue === 'function'
                ? withEventModifiers(
                    nextValue as (event: Event) => unknown,
                    (binding.modifiers ?? []) as readonly EventModifier[]
                  )
                : null;
            slot.write(handler);
          } else if (binding.kind === 'directive' && binding.directiveKind === 'use') {
            slot.write({
              name: binding.name ?? '',
              value: nextValue,
            });
          } else {
            slot.write(nextValue);
          }

          previousBindingValues[bindingIndex] = nextValue;
          hasPreviousBindingValue[bindingIndex] = true;
        }
      });
    },
    activate() {
      slots.forEach((slot) => {
        (slot as Partial<RetainedSlotLifecycle>).activate?.();
      });
    },
    deactivate() {
      slots.forEach((slot) => {
        (slot as Partial<RetainedSlotLifecycle>).deactivate?.();
      });
    },
    destroy() {
      slots.forEach((slot) => slot.destroy());
    },
  };
};

type HydratableTemplateSlot = Slot<unknown> & {
  hydrate?(nodes: readonly Node[], value?: unknown): void;
};

const hydrateTemplateSlot = (
  mounted: MountedStaticTemplate,
  binding: TemplateBindingPayload,
  slot: Slot<unknown>,
  ...args: unknown[]
): void => {
  const slotIndex = binding.slotIndex >= 0 ? binding.slotIndex : null;
  if (slotIndex === null || !hasHydrationSlot(mounted, slotIndex)) {
    // 编译期没登记 hydration 槽位时，说明该 binding 不需要从 SSR DOM 接管。
    return;
  }

  const hydratableSlot = slot as HydratableTemplateSlot;
  if (typeof hydratableSlot.hydrate !== 'function') {
    return;
  }

  if (binding.kind === 'if') {
    // `if` hydration 需要根据当前求值结果判定保留哪一侧分支。
    const nodes = readHydrationSlotNodes(mounted, slotIndex);
    if (nodes.length === 0) {
      return;
    }
    const nextValue = binding.evaluate(...args);
    const payload = nextValue as { when?: unknown } | null;
    hydratableSlot.hydrate(nodes, Boolean(payload?.when ?? nextValue));
    return;
  }

  if (binding.kind === 'teleport') {
    const nextValue = binding.evaluate(...args);
    const target =
      typeof nextValue === 'object' &&
      nextValue !== null &&
      '__lania_teleport' in nextValue
        ? (nextValue as { target?: unknown }).target
        : nextValue;
    // teleport 的 hydration 节点来自目标容器，而不是当前模板局部片段。
    const nodes = readTeleportNodes(mounted, slotIndex, target);
    if (nodes.length === 0) {
      return;
    }
    hydratableSlot.hydrate(nodes, target);
    return;
  }

  if (binding.kind === 'boundary') {
    // boundary 在 hydrate 阶段先接管已有节点，再交由后续 write 做状态更新。
    const nextValue = binding.evaluate(...args);
    const nodes = readHydrationSlotNodes(mounted, slotIndex);
    if (nodes.length === 0) {
      return;
    }
    hydratableSlot.hydrate(nodes, nextValue);
    return;
  }

  const nodes = readHydrationSlotNodes(mounted, slotIndex);
  if (nodes.length === 0) {
    return;
  }
  hydratableSlot.hydrate(nodes);
};

export const mountHydratedBinding = (
  nodes: readonly Node[],
  _template: StaticTemplate,
  bindings: readonly TemplateBindingPayload[],
  ...args: unknown[]
): MountedBindingInstance => {
  // hydrated template 直接围绕现有节点建立 mounted 视图，不再重新克隆模板 DOM。
  const mounted = createHydratedTemplate(nodes);
  const slots = bindings.map((binding, bindingIndex) =>
    createTemplateSlot(
      mounted,
      binding,
      binding.slotIndex >= 0 ? binding.slotIndex : bindingIndex
    )
  );
  const previousBindingValues: unknown[] = new Array(bindings.length);
  const hasPreviousBindingValue = new Array(bindings.length).fill(false);

  bindings.forEach((binding, bindingIndex) => {
    const slot = slots[bindingIndex];
    if (!slot) {
      return;
    }

    // 先 hydrate 再 write，确保 slot 内部拿到的是服务端已有 DOM，而不是新建节点。
    hydrateTemplateSlot(mounted, binding, slot, ...args);
    previousBindingValues[bindingIndex] = writeTemplateBindingSlot(slot, binding, ...args);
    hasPreviousBindingValue[bindingIndex] = true;
  });

  return {
    fragment: document.createDocumentFragment(),
    nodes: [...nodes],
    mounted,
    slots,
    update(...nextArgs: unknown[]) {
      bindings.forEach((binding, bindingIndex) => {
        const slot = slots[bindingIndex];
        if (slot) {
          const nextValue = binding.evaluate(...nextArgs);
          if (
            hasPreviousBindingValue[bindingIndex] &&
            Object.is(previousBindingValues[bindingIndex], nextValue)
          ) {
            return;
          }

          if (binding.kind === 'event') {
            const handler =
              typeof nextValue === 'function'
                ? withEventModifiers(
                    nextValue as (event: Event) => unknown,
                    (binding.modifiers ?? []) as readonly EventModifier[]
                  )
                : null;
            slot.write(handler);
          } else if (binding.kind === 'directive' && binding.directiveKind === 'use') {
            slot.write({
              name: binding.name ?? '',
              value: nextValue,
            });
          } else {
            slot.write(nextValue);
          }

          previousBindingValues[bindingIndex] = nextValue;
          hasPreviousBindingValue[bindingIndex] = true;
        }
      });
    },
    activate() {
      slots.forEach((slot) => {
        (slot as Partial<RetainedSlotLifecycle>).activate?.();
      });
    },
    deactivate() {
      slots.forEach((slot) => {
        (slot as Partial<RetainedSlotLifecycle>).deactivate?.();
      });
    },
    destroy() {
      slots.forEach((slot) => slot.destroy());
    },
  };
};
