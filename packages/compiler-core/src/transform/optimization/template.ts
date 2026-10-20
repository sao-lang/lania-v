import type {
  ComponentIR,
  ElementIR,
  ExpressionIR,
  IfIR,
  ListIR,
  TemplateIRNode,
  TextIR,
} from '../../ir/component';
import {
  applyComputedInlineToExpression,
  applyStaticSignalInlineToExpression,
  buildStaticSignalFoldMap,
  tryEvaluateConstantExpression,
} from './expression';
import type { OptimizationPassIR } from './types';

/**
 * 模板优化。
 *
 * 这一轮优化工作发生在模板 IR 已经构建完成之后、render/codegen 之前。
 * 目标不是改变模板结构语义，而是尽可能把能在编译期完成的事情提前做掉：
 * 1. 内联静态 signal；
 * 2. 内联可安全替换的 computed；
 * 3. 对纯常量表达式做 constant folding；
 * 4. 递归把这些优化传播到 Element / If / Dynamic / Teleport / KeepAlive 等节点。
 *
 * 最终效果是：运行时需要求值的表达式更少，生成的模板/渲染代码也更直接。
 *
 * 这里的设计原则是“只做语义等价的收敛，不重写模板结构意图”：
 * 除非某个表达式已经可以确定折叠成纯静态文本，否则节点类型和层级尽量保持不变，
 * 让后续 slot 分配与 codegen 仍然能按熟悉的 IR 形态工作。
 *
 * 换句话说，这一层更像“表达式层面的瘦身器”：
 * - 让上游分析得到的静态信息真正落到模板节点上；
 * - 保持 render plan 仍可依赖稳定的节点种类和 slot 语义；
 * - 为后续 slot packing、静态模板重建和代码生成减少分支噪音。
 */

// 这里重新序列化静态属性，主要服务于某些优化后重新生成静态模板片段的场景。
const renderStaticAttributes = (attributes: Record<string, string | true>): string => {
  const pairs = Object.entries(attributes).map(([name, value]) => {
    return value === true ? name : `${name}="${value}"`;
  });

  return pairs.length > 0 ? ` ${pairs.join(' ')}` : '';
};

// 收集模板子树里所有可能参与优化分析的表达式源码。
export const collectTemplateExpressions = (nodes: TemplateIRNode[]): string[] => {
  return nodes.flatMap((node) => {
    switch (node.type) {
      case 'ElementIR':
        return [
          ...node.dynamicAttributes.map((attribute) => attribute.expression),
          ...node.directives.map((directive) => directive.expression),
          ...collectTemplateExpressions(node.children),
        ];
      case 'BoundaryIR':
      case 'TransitionIR':
        return collectTemplateExpressions(node.children);
      case 'ExpressionIR':
      case 'ListIR':
        return [node.expression];
      case 'IfIR':
        return [
          node.expression,
          ...(node.children ? collectTemplateExpressions(node.children) : []),
          ...(node.fallbackChildren ? collectTemplateExpressions(node.fallbackChildren) : []),
        ];
      case 'DynamicIR':
        return [
          node.componentExpression,
          node.propsExpression,
          ...(node.children ? collectTemplateExpressions(node.children) : []),
        ];
      case 'TeleportIR':
        return [node.targetExpression, ...(node.children ? collectTemplateExpressions(node.children) : [])];
      case 'KeepAliveIR':
        return [
          node.payloadExpression,
          ...(node.children ? collectTemplateExpressions(node.children) : []),
        ];
      default:
        return [];
    }
  });
};

// 基于模板、computed、effect、lifecycle 和 setup 源码，估算哪些 signal 实际被使用到了。
export const collectUsedSignalNames = (component: ComponentIR): Set<string> => {
  const sources = [
    ...collectTemplateExpressions(component.template.roots),
    ...component.computed.map((computed) => computed.expression ?? ''),
    ...component.effects.map((effect) => effect.body),
    ...component.lifecycleCallbacks.flatMap((callback) => [callback.body ?? '', callback.params]),
    ...component.setupBindings.flatMap((binding) => [
      binding.body ?? '',
      binding.initializer ?? '',
      binding.params,
    ]),
  ].filter((source): source is string => typeof source === 'string');
  const usedSignals = new Set<string>();

  component.signals.forEach((signal) => {
    // 这里按常见访问模式做保守匹配：`this.foo`、`foo()`、`foo.set(...)`。
    const patterns = [
      new RegExp(`\\bthis\\.${signal.name}\\b`),
      new RegExp(`\\b${signal.name}\\(`),
      new RegExp(`\\b${signal.name}\\.set\\(`),
    ];

    if (sources.some((source) => patterns.some((pattern) => pattern.test(source)))) {
      // 这里宁可多算少量“可能用到”的 signal，也不冒险把真实依赖漏掉。
      usedSignals.add(signal.name);
    }
  });

  return usedSignals;
};

// 递归优化模板节点树。
// 结构上尽量保持原节点类型不变，只有在表达式可折叠成纯文本时才降级为 `TextIR`。
//
// `insideBlockTemplate` 表示当前是否处于 block 自己的模板（If / Dynamic / Boundary…）。
// 这类模板的 HTML 在 lowering 阶段就已固化成字符串，优化阶段不会重建，
// 因此在这里折叠表达式会把 `__LANIA_SLOT_n__` 占位留在 HTML 里而丢掉对应 binding。
export const optimizeTemplateNodes = (
  nodes: TemplateIRNode[],
  component: ComponentIR,
  optimization: OptimizationPassIR,
  usedComputed: Set<string>,
  staticSignals: Record<string, string>,
  insideBlockTemplate = false
): TemplateIRNode[] => {
  const optimizeChildren = (children: TemplateIRNode[], insideBlock = insideBlockTemplate) => {
    return optimizeTemplateNodes(
      children,
      component,
      optimization,
      usedComputed,
      staticSignals,
      insideBlock
    );
  };

  return nodes.map((node): TemplateIRNode => {
    if (node.type === 'TextIR') {
      return node;
    }

    if (node.type === 'ElementIR') {
      // 元素节点主要优化动态属性、指令表达式和其子节点。
      return {
        ...node,
        dynamicAttributes: node.dynamicAttributes.map((attribute) => ({
          ...attribute,
          expression: applyComputedInlineToExpression(
            applyStaticSignalInlineToExpression(attribute.expression, staticSignals, optimization),
            component,
            usedComputed
          ),
        })),
        directives: node.directives.map((directive) => ({
          ...directive,
          expression: applyComputedInlineToExpression(
            applyStaticSignalInlineToExpression(directive.expression, staticSignals, optimization),
            component,
            usedComputed
          ),
        })),
        children: optimizeChildren(node.children),
      };
    }

    if (node.type === 'BoundaryIR' || node.type === 'TransitionIR') {
      // 边界类节点本身的核心语义不动，只继续向子树传播优化。
      return {
        ...node,
        children: optimizeChildren(node.children, true),
      };
    }

    // 不同节点把“主表达式”存放在不同字段里，这里先归一出一个待优化源串。
    const expressionSource =
      node.type === 'TeleportIR'
        ? node.targetExpression
        : node.type === 'DynamicIR'
          ? `({ component: ${node.componentExpression}, props: ${node.propsExpression} })`
          : node.type === 'StaticComponentIR'
            ? node.propsExpression
            : node.type === 'KeepAliveIR'
              ? node.payloadExpression
              : node.expression;
    const inlinedExpression = applyComputedInlineToExpression(
      applyStaticSignalInlineToExpression(expressionSource, staticSignals, optimization),
      component,
      usedComputed
    );
    // 先做静态 signal 替换，再做 computed 内联，保证表达式来源尽量收敛成最终形态。

    if (node.type === 'ExpressionIR') {
      const folded = insideBlockTemplate
        ? null
        : tryEvaluateConstantExpression(inlinedExpression);

      if (folded !== null) {
        // 纯常量文本表达式可以直接退化成静态 TextIR，彻底消除运行时 slot。
        optimization.constantFoldedExpressions.push({
          original: node.expression,
          folded,
          path: node.path,
        });

        const textNode: TextIR = {
          type: 'TextIR',
          path: node.path,
          value: folded,
        };

        return textNode;
      }

      const expressionNode: ExpressionIR = {
        ...node,
        expression: inlinedExpression,
      };

      return expressionNode;
    }

    if (node.type === 'ListIR') {
      // 列表优化只改 iterable 表达式，不碰列表模板本身。
      const listNode: ListIR = {
        ...node,
        expression: inlinedExpression,
      };

      return listNode;
    }

    if (node.type === 'TeleportIR') {
      // Teleport 的主表达式是目标容器，不是 children 本身。
      return {
        ...node,
        targetExpression: inlinedExpression,
        children: node.children ? optimizeChildren(node.children, true) : undefined,
      };
    }

    if (node.type === 'DynamicIR') {
      // Dynamic 节点的组件表达式和 props 表达式需要分别独立优化。
      return {
        ...node,
        componentExpression: applyComputedInlineToExpression(
          applyStaticSignalInlineToExpression(
            node.componentExpression,
            staticSignals,
            optimization
          ),
          component,
          usedComputed
        ),
        propsExpression: applyComputedInlineToExpression(
          applyStaticSignalInlineToExpression(node.propsExpression, staticSignals, optimization),
          component,
          usedComputed
        ),
        children: node.children ? optimizeChildren(node.children, true) : undefined,
      };
    }

    if (node.type === 'KeepAliveIR') {
      // KeepAlive 的 payload 已经编码了运行时所需状态，这里只替换其中可静态化的表达式片段。
      return {
        ...node,
        payloadExpression: inlinedExpression,
        children: node.children ? optimizeChildren(node.children, true) : undefined,
      };
    }

    if (node.type === 'StaticComponentIR') {
      // 静态组件只保留 props 更新入口，本体标签信息不参与表达式优化。
      return {
        ...node,
        propsExpression: inlinedExpression,
      };
    }

    if (node.type === 'IfIR') {
      // `IfIR` 既要优化条件本身，也要继续递归 truthy/fallback 两棵子树。
      const ifNode: IfIR = {
        ...node,
        expression: inlinedExpression,
        children: node.children ? optimizeChildren(node.children, true) : undefined,
        fallbackChildren: node.fallbackChildren
          ? optimizeChildren(node.fallbackChildren, true)
          : undefined,
      };

      return ifNode;
    }

    return node;
  });
};

export const collectUsedSlotIndices = (nodes: TemplateIRNode[], used = new Set<number>()): Set<number> => {
  nodes.forEach((node) => {
    if (
      node.type === 'ExpressionIR' ||
      node.type === 'StaticComponentIR' ||
      node.type === 'ListIR' ||
      node.type === 'IfIR' ||
      node.type === 'DynamicIR' ||
      node.type === 'TeleportIR' ||
      node.type === 'KeepAliveIR' ||
      node.type === 'TransitionIR'
    ) {
      // 这些节点都自带主 slot，可直接纳入 packing 候选集。
      used.add(node.slotIndex);

      // 块（含 IfIR）内部的节点使用该块自己的局部坐标系，由块 payload 承载，
      // 不参与根模板的 slot packing，否则会把内层编号压成外层序号造成冲突。
      return;
    }

    if (node.type === 'ElementIR') {
      // 元素节点的 slot 分散在属性/事件/指令和子树里，本节点本身不占独立动态 slot。
      collectUsedSlotIndices(node.children, used);
      return;
    }

    if (node.type === 'BoundaryIR') {
      collectUsedSlotIndices(node.children, used);
    }
  });

  return used;
};

export const buildSlotPackingMap = (nodes: TemplateIRNode[]): Record<number, number> => {
  // slot packing 会把稀疏 slot 索引压紧成连续区间，减少后续运行时表的空洞。
  const used = [...collectUsedSlotIndices(nodes)].sort((left, right) => left - right);

  return Object.fromEntries(used.map((slotIndex, index) => [slotIndex, index]));
};

export const applySlotPacking = (
  nodes: TemplateIRNode[],
  slotPackingMap: Record<number, number>
): TemplateIRNode[] => {
  return nodes.map((node): TemplateIRNode => {
    if (
      node.type === 'ExpressionIR' ||
      node.type === 'ListIR' ||
      node.type === 'IfIR' ||
      node.type === 'DynamicIR' ||
      node.type === 'TeleportIR' ||
      node.type === 'KeepAliveIR'
    ) {
      // 条件块分支内部使用独立的局部坐标系（path 从 0 开始、slot 独立编号），
      // 不参与根模板的 packing 重映射，因此这里不再递归重映射其子树。
      const remapped = {
        ...node,
        slotIndex: slotPackingMap[node.slotIndex] ?? node.slotIndex,
      } as TemplateIRNode;

      return remapped;
    }
    // 这些节点直接持有主 slot，因此优先映射它们自己的索引。

    if (node.type === 'BoundaryIR' || node.type === 'TransitionIR') {
      // Boundary/Transition 自身 slot 由 block 渲染路径兜底保持稳定，这里主要递归修正其子树引用。
      return {
        ...node,
        children: applySlotPacking(node.children, slotPackingMap),
      };
    }

    if (node.type === 'ElementIR') {
      return {
        ...node,
        dynamicAttributes: node.dynamicAttributes.map((attribute) => ({
          ...attribute,
          slotIndex:
            attribute.slotIndex !== undefined
              ? (slotPackingMap[attribute.slotIndex] ?? attribute.slotIndex)
              : undefined,
        })),
        events: node.events.map((event) => ({
          ...event,
          slotIndex:
            event.slotIndex !== undefined
              ? (slotPackingMap[event.slotIndex] ?? event.slotIndex)
              : undefined,
        })),
        directives: node.directives.map((directive) => ({
          ...directive,
          slotIndex:
            directive.slotIndex !== undefined
              ? (slotPackingMap[directive.slotIndex] ?? directive.slotIndex)
              : undefined,
        })),
        children: applySlotPacking(node.children, slotPackingMap),
      };
    }

    return node;
  });
};

export const rebuildRenderStaticNode = (
  node: ElementIR,
  renderNodes: (nodes: TemplateIRNode[]) => string
): string => {
  // 这里假设传入的是已经可静态化的元素节点，重新拼出 render plan 里的 HTML 片段。
  return `<${node.tagName}${renderStaticAttributes(node.staticAttributes)}>${renderNodes(node.children)}</${node.tagName}>`;
};

export const createStaticSignals = (
  component: ComponentIR,
  initialUsedSignals: Set<string>
): Record<string, string> => {
  // 静态 signal 映射集中在这里创建，便于优化阶段与后续 codegen 共用同一份折叠结果。
  return buildStaticSignalFoldMap(component, initialUsedSignals);
};
