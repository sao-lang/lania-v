/**
 * 实现增强组件与底层运行时之间的兼容桥。
 *
 * 这里把 `When`、`Each`、`Dynamic`、`Slot` 等声明式 props
 * 翻译成真实可挂载的 renderable，并在需要时读取当前运行时作用域。
 */
import { getCurrentRuntimeScope, withRuntimeScope } from '@lania-v/runtime';
import type {
  DynamicProps,
  EachProps,
  EnhancedRenderable,
  SlotProps,
  WhenProps,
} from '../types';
import { appendRenderable, asRenderable, invokeRenderable } from './renderable';

// 子内容可能是函数、数组或普通值，统一走 renderable 归一化。
export const renderCompatChildren = (children: unknown): EnhancedRenderable => {
  return invokeRenderable(asRenderable(children)) as EnhancedRenderable;
};

export const renderCompatWhen = (props: WhenProps): EnhancedRenderable => {
  return props.when
    ? renderCompatChildren(props.children)
    : (invokeRenderable(props.fallback) as EnhancedRenderable);
};

export const renderCompatEach = (
  props: EachProps<unknown>
): EnhancedRenderable => {
  const items = props.items ?? [];

  if (items.length === 0) {
    return invokeRenderable(props.fallback) as EnhancedRenderable;
  }

  if (typeof props.children === 'function') {
    const mapper = props.children as (
      item: unknown,
      index: number
    ) => EnhancedRenderable;
    return items.map((item, index) =>
      mapper(item, index)
    ) as unknown as EnhancedRenderable;
  }

  return asRenderable(props.children) as EnhancedRenderable;
};

// `Dynamic` 需要先挑出目标类型，再把 children 与 props 合并成同一份入参。
export const renderCompatDynamic = (
  props: DynamicProps
): EnhancedRenderable => {
  const target = props.component ?? props.is;
  const hasExplicitChildren =
    props.children !== undefined &&
    props.children !== null &&
    (!Array.isArray(props.children) || props.children.length > 0);
  const normalizedChildren = hasExplicitChildren
    ? Array.isArray(props.children) && props.children.length === 1
      ? props.children[0]
      : props.children
    : undefined;
  const nextProps = {
    ...(props.props ?? {}),
    ...(hasExplicitChildren
      ? {
          children: normalizedChildren,
        }
      : {}),
  };

  if (target == null) {
    return invokeRenderable(props.fallback) as EnhancedRenderable;
  }

  // 字符串目标退化为原生元素创建，按 attribute 方式灌入动态属性。
  if (typeof target === 'string' && target.trim().length > 0) {
    const element = document.createElement(target);
    Object.entries(nextProps).forEach(([name, value]) => {
      if (name === 'children') {
        appendRenderable(element, value);
        return;
      }

      if (value == null || value === false) {
        element.removeAttribute(name);
        return;
      }

      element.setAttribute(name, String(value));
    });
    return element;
  }

  if (target instanceof Element) {
    return target;
  }

  // 组件函数需要继承当前运行时作用域，确保 slotContent 等上下文继续可见。
  if (typeof target === 'function') {
    return withRuntimeScope(
      {
        slotContent: normalizedChildren,
      },
      () =>
        (target as (props: Record<string, unknown>) => EnhancedRenderable)(
          nextProps
        )
    );
  }

  return invokeRenderable(props.fallback) as EnhancedRenderable;
};

const resolveScopedSlotContent = (content: unknown, name?: string): unknown => {
  if (!name) {
    return content;
  }

  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const record = content as Record<string, unknown>;
    return record[name] ?? record.default;
  }

  return undefined;
};

const invokeScopedSlot = (
  slot: (...values: unknown[]) => unknown,
  args: unknown
): EnhancedRenderable => {
  const result = Array.isArray(args) ? slot(...args) : slot(args);
  return renderCompatChildren(result);
};

export const renderCompatSlot = (props: SlotProps): EnhancedRenderable => {
  const fallbackContent = (props.children ??
    props.fallback) as EnhancedRenderable;
  const scope = getCurrentRuntimeScope();
  const host = scope?.host;
  const slottedContent = resolveScopedSlotContent(
    scope?.slotContent,
    props.name
  );

  // 函数型 slot 需要把 args 传回父组件，无法走原生 <slot> 投影。
  if (typeof slottedContent === 'function') {
    return invokeScopedSlot(
      slottedContent as (...values: unknown[]) => unknown,
      props.args
    );
  }

  // Shadow DOM 宿主优先输出原生 slot 元素，让浏览器自己完成分发。
  if (host instanceof HTMLElement && host.shadowRoot) {
    const slot = document.createElement('slot');
    if (props.name) {
      slot.name = props.name;
    }
    appendRenderable(slot, fallbackContent);
    return slot;
  }

  if (slottedContent !== undefined && slottedContent !== null) {
    return renderCompatChildren(slottedContent);
  }

  return invokeRenderable(fallbackContent) as EnhancedRenderable;
};

export const readCompatUpdateHost = ():
  { requestUpdate?: () => void } | undefined => {
  return getCurrentRuntimeScope()?.host as
    { requestUpdate?: () => void } | undefined;
};
