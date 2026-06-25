import type { ElementNode } from '../../../ast';
import { getEnhancedComponentRegistryEntry } from '@lania-v/shared';
import {
  buildKeepAlivePayloadExpression,
  buildRuntimePropsExpression,
} from '../helpers/payload';
import {
  getAttributeExpression,
  getAttributeStringValue,
  isStaticComponentTag,
} from '../helpers/template-helpers';
import type {
  DynamicIR,
  KeepAliveIR,
  StaticComponentIR,
  TeleportIR,
  TemplateLowerer,
} from '../types';

/**
 * 动态类增强组件 lowering。
 *
 * 这里负责把一部分“运行时决定结构或挂载目标”的模板节点，
 * 例如 `Teleport`、`Dynamic`、组件引用、`KeepAlive` 等，
 * 下降为专门的模板 IR 节点。
 *
 * 这些节点的共同点是：
 * - 静态 HTML 只能作为占位壳或子模板；
 * - 真正的组件实例、目标容器或缓存策略要留到运行时决定；
 * - 因此 lowering 阶段主要负责收集表达式、子树模板和 payload 所需元信息。
 */
const isComponentReferenceTag = (tagName: string): boolean => {
  // 大写标签默认视为组件引用，但注册过的 enhanced component 走另一条分支。
  return /^[A-Z]/.test(tagName) && !getEnhancedComponentRegistryEntry(tagName);
};

export const lowerTeleportElement = (
  child: ElementNode,
  path: number[],
  slotIndex: number,
  lowerTemplateChildren: TemplateLowerer
): TeleportIR | null => {
  // `to` 既可能是动态表达式，也可能是静态字符串属性，这里统一转成表达式文本。
  const targetExpression =
    getAttributeExpression(child, 'to') ??
    (getAttributeStringValue(child, 'to')
      ? JSON.stringify(getAttributeStringValue(child, 'to'))
      : null);

  if (!targetExpression) {
    return null;
  }

  // Teleport 子节点会在目标容器中渲染，因此仍需独立保留子模板描述。
  const template = lowerTemplateChildren(child.children, [], 0, 0, 0, {
    preserveChildrenOnlyEnhancedAsDynamic: true,
  });

  return {
    type: 'TeleportIR',
    path,
    slotIndex,
    targetExpression,
    templateHtml: template.staticHtml,
    hoistName: `__teleport_slot_${path.join('_') || 'root'}_${slotIndex}`,
    children: template.nodes,
  };
};

export const lowerDynamicElement = (
  child: ElementNode,
  path: number[],
  slotIndex: number,
  lowerTemplateChildren: TemplateLowerer
): DynamicIR | null => {
  const enhancedEntry = getEnhancedComponentRegistryEntry(child.tagName);
  // 兼容 `<Dynamic component={...}>`、`<component is="...">` 以及注册动态组件别名。
  const componentExpression =
    getAttributeExpression(child, 'component') ??
    getAttributeExpression(child, 'is') ??
    (enhancedEntry?.irKind === 'DynamicIR' && child.tagName !== 'Dynamic'
      ? JSON.stringify(child.tagName)
      : null) ??
    (child.tagName === 'component' && getAttributeStringValue(child, 'is')
      ? JSON.stringify(getAttributeStringValue(child, 'is'))
      : null);

  if (!componentExpression) {
    return null;
  }

  // 动态组件的插槽子树仍要先降成模板，以便运行时切换组件时复用。
  const template = lowerTemplateChildren(child.children, [], 0, 0, 0, {
    preserveChildrenOnlyEnhancedAsDynamic: true,
  });
  const propsExpression = buildRuntimePropsExpression(child, ['component', 'is', 'props']);

  return {
    type: 'DynamicIR',
    path,
    slotIndex,
    componentExpression,
    propsExpression,
    templateHtml: template.staticHtml,
    hoistName: `__dynamic_slot_${path.join('_') || 'root'}_${slotIndex}`,
    children: template.nodes,
  };
};

export const lowerComponentReferenceElement = (
  child: ElementNode,
  path: number[],
  slotIndex: number,
  lowerTemplateChildren: TemplateLowerer
): DynamicIR | null => {
  if (!isComponentReferenceTag(child.tagName)) {
    return null;
  }

  // 普通组件引用最终也走 `DynamicIR`，只是组件来源改为直接引用当前标识符。
  const template = lowerTemplateChildren(child.children, [], 0, 0, 0, {
    preserveChildrenOnlyEnhancedAsDynamic: true,
  });

  return {
    type: 'DynamicIR',
    path,
    slotIndex,
    componentExpression: child.tagName,
    propsExpression: buildRuntimePropsExpression(child, ['props']),
    templateHtml: template.staticHtml,
    hoistName: `__dynamic_slot_${path.join('_') || 'root'}_${slotIndex}`,
    children: template.nodes,
  };
};

export const lowerKeepAliveElement = (
  child: ElementNode,
  path: number[],
  slotIndex: number,
  lowerTemplateChildren: TemplateLowerer
): KeepAliveIR => {
  // KeepAlive 的核心不是 DOM 结构，而是缓存 payload，因此需要同时保留模板和 payload。
  const template = lowerTemplateChildren(child.children, [], 0, 0, 0, {
    preserveChildrenOnlyEnhancedAsDynamic: true,
  });
  const hoistName = `__keepalive_slot_${path.join('_') || 'root'}_${slotIndex}`;

  return {
    type: 'KeepAliveIR',
    path,
    slotIndex,
    templateHtml: template.staticHtml,
    hoistName,
    payloadExpression: buildKeepAlivePayloadExpression(
      child,
      template.staticHtml,
      hoistName,
      slotIndex
    ),
    children: template.nodes,
  };
};

export const lowerStaticComponentElement = (
  child: ElementNode,
  path: number[],
  slotIndex: number
): StaticComponentIR | null => {
  // 仅无子节点的静态组件才能直接压成纯 props + event 的静态组件绑定。
  if (!isStaticComponentTag(child.tagName) || child.children.length > 0) {
    return null;
  }

  return {
    type: 'StaticComponentIR',
    path,
    slotIndex,
    tagName: child.tagName,
    propsExpression: buildRuntimePropsExpression(child, ['props']),
    eventNames: child.events.map((event) => event.name),
  };
};
