import ts from 'typescript';

import type { ComponentIR, TemplateIRNode } from '../../ir/component';
import {
  analyzeExpressionDependencies,
  parseExpressionNode,
} from './expression';
import type {
  CrossComponentAnalysisIR,
  CrossComponentBindingIR,
  CrossComponentUsageIR,
} from './types';
import { getObjectLiteralPropertyName, isStaticComponentTag } from './utils';

/**
 * 跨组件依赖分析。
 *
 * 这个模块关注的不是“组件内部谁依赖谁”，而是“当前组件如何使用其他组件”。
 * 它会扫描动态组件、静态组件标签以及它们的 props / events 绑定，
 * 产出一份面向调度与拆分策略的跨组件 usage 清单。
 *
 * 这些信息主要服务于两类场景：
 * - 估算某个组件使用点的更新频率，并给对应 updater 标注优先级；
 * - 为后续代码拆分或异步加载提供可落地的 split point 候选。
 *
 * 这里的输出刻意保持“摘要化”而不是完整模板快照：
 * - 只记录组件名、所在路径、绑定依赖与事件名；
 * - 不复制整个子树结构，避免把这一步耦合成第二份模板 IR；
 * - 优先保证后续调度器/拆分器能快速回答“谁依赖谁、值不值得拆”。
 *
 * 可以把结果理解成一份“组件使用热区地图”：
 * - 某个组件在什么位置被用到；
 * - 它的 props 受哪些 signal 影响；
 * - 这个使用点更像高频更新点，还是普通组件挂载点。
 */
export const extractCrossComponentPropBindings = (
  expression: string,
  propNames: ReadonlySet<string>
): CrossComponentBindingIR[] => {
  const shouldIgnorePropKey = (name: string): boolean => {
    // 事件与指令透传字段不属于常规 props 依赖，不参与这里的绑定分析。
    return name === '__lania_events' || name === '__lania_directives';
  };

  let parsed = parseExpressionNode(expression);
  while (ts.isParenthesizedExpression(parsed)) {
    parsed = parsed.expression;
  }

  if (!ts.isObjectLiteralExpression(parsed)) {
    // 非对象字面量 props 无法静态拆键，只能整体按 spread 处理。
    return [
      {
        name: '__spread__',
        expression,
        signalDependencies: analyzeExpressionDependencies(
          expression,
          propNames
        ),
      },
    ];
  }

  return parsed.properties.flatMap((property) => {
    if (ts.isSpreadAssignment(property)) {
      let spreadExpression = property.expression;
      while (ts.isParenthesizedExpression(spreadExpression)) {
        spreadExpression = spreadExpression.expression;
      }

      if (ts.isObjectLiteralExpression(spreadExpression)) {
        // 对字面量 spread 做一次展开，尽量保留按 prop 粒度的依赖信息。
        return extractCrossComponentPropBindings(
          spreadExpression.getText(),
          propNames
        );
      }

      return [
        {
          name: '__spread__',
          expression: property.expression.getText(),
          // 非字面量 spread 只能把依赖挂在一个聚合绑定上，等待上层按整体处理。
          signalDependencies: analyzeExpressionDependencies(
            property.expression.getText(),
            propNames
          ),
        },
      ];
    }

    if (ts.isShorthandPropertyAssignment(property)) {
      if (shouldIgnorePropKey(property.name.text)) {
        return [];
      }

      return [
        {
          name: property.name.text,
          expression: property.name.text,
          signalDependencies: analyzeExpressionDependencies(
            property.name.text,
            propNames
          ),
        },
      ];
    }

    if (ts.isPropertyAssignment(property)) {
      const name = getObjectLiteralPropertyName(property.name);
      if (!name || shouldIgnorePropKey(name)) {
        return [];
      }

      const initializerText = property.initializer.getText();
      return [
        {
          name,
          expression: initializerText,
          signalDependencies: analyzeExpressionDependencies(
            initializerText,
            propNames
          ),
        },
      ];
    }

    return [];
  });
};

export const buildCrossComponentAnalysis = (
  component: ComponentIR,
  propNames: ReadonlySet<string>
): CrossComponentAnalysisIR => {
  const componentUsages: CrossComponentUsageIR[] = [];
  const updaterPriorities: Record<string, 'high' | 'normal'> = {};
  const highFrequencyUpdaters = new Set<string>();

  const createUsage = (
    usage: Omit<
      CrossComponentUsageIR,
      'dependencySignals' | 'updatePriority' | 'codeSplitEligible'
    >
  ): CrossComponentUsageIR => {
    // 把 prop 绑定里涉及的 signal 名字拍平，得到当前组件使用点的依赖摘要。
    const dependencySignals = [
      ...new Set(
        usage.propBindings.flatMap((binding) =>
          binding.signalDependencies.map((dependency) => dependency.name)
        )
      ),
    ].sort();
    const updatePriority: 'high' | 'normal' =
      usage.updater &&
      usage.propBindings.length > 0 &&
      dependencySignals.length <= 1 &&
      dependencySignals.length > 0
        ? 'high'
        : 'normal';
    // “单 updater + 少量依赖”通常意味着高频且成本低，适合提前打高优先级标签。

    if (usage.updater) {
      updaterPriorities[usage.updater] = updatePriority;
      if (updatePriority === 'high') {
        highFrequencyUpdaters.add(usage.updater);
      }
    }

    return {
      ...usage,
      dependencySignals,
      updatePriority,
      // 这里只做一个轻量启发式判断，真正的拆分策略还可以在后续阶段继续收紧。
      codeSplitEligible: usage.component.trim().length > 0,
    };
  };

  const visit = (nodes: TemplateIRNode[]): void => {
    nodes.forEach((node) => {
      // 这里按模板 IR 的组件边界递归下钻，遇到组件使用点就抽一条 usage 记录。
      if (node.type === 'DynamicIR') {
        componentUsages.push(
          createUsage({
            kind: 'dynamic-component',
            component: node.componentExpression,
            path: node.path,
            slotIndex: node.slotIndex,
            updater: `updateDynamicSlot${node.slotIndex}`,
            propBindings: extractCrossComponentPropBindings(
              node.propsExpression,
              propNames
            ),
            eventBindings: [],
          })
        );

        if (node.children) {
          // 动态组件的 slot children 里也可能继续嵌套组件使用。
          visit(node.children);
        }
        return;
      }

      if (node.type === 'StaticComponentIR') {
        componentUsages.push(
          createUsage({
            kind: 'static-component',
            component: node.tagName,
            path: node.path,
            slotIndex: node.slotIndex,
            updater: `updateComponentSlot${node.slotIndex}`,
            propBindings: extractCrossComponentPropBindings(
              node.propsExpression,
              propNames
            ),
            eventBindings: node.eventNames,
          })
        );
        return;
      }

      if (node.type === 'ElementIR') {
        if (isStaticComponentTag(node.tagName)) {
          // 以大写标签出现的静态组件，直接从动态属性和事件里提取 usage 信息。
          componentUsages.push(
            createUsage({
              kind: 'static-component',
              component: node.tagName,
              path: node.path,
              updater: null,
              propBindings: node.dynamicAttributes.map((attribute) => ({
                name: attribute.name,
                expression: attribute.expression,
                signalDependencies: analyzeExpressionDependencies(
                  attribute.expression,
                  propNames
                ),
              })),
              eventBindings: node.events.map((event) => event.name),
            })
          );
        }

        // 普通 DOM 元素自身不是组件 usage，但其子树仍可能继续出现组件节点。
        visit(node.children);
        return;
      }

      if (node.type === 'BoundaryIR' || node.type === 'TransitionIR') {
        // 这两类 block 自身不是跨组件 usage，但内部 children 仍可能嵌套真实组件使用点。
        visit(node.children);
        return;
      }

      if (node.type === 'IfIR') {
        if (node.children) {
          visit(node.children);
        }
        if (node.fallbackChildren) {
          visit(node.fallbackChildren);
        }
        return;
      }

      if (node.type === 'TeleportIR' && node.children) {
        visit(node.children);
      }
    });
  };

  visit(component.template.roots);

  return {
    componentUsages,
    highFrequencyUpdaters: [...highFrequencyUpdaters].sort(),
    updaterPriorities,
    // split point 只保留最终可拆分 usage 的稳定摘要，
    // 这样即使后面替换具体策略，也能继续复用这份分析结果做键控和归档。
    splitPoints: componentUsages
      .filter((usage) => usage.codeSplitEligible)
      .map((usage) => ({
        key: `${usage.kind}:${usage.component}:${usage.path.join('.')}`,
        component: usage.component,
        path: usage.path,
        updater: usage.updater,
        kind: usage.kind,
      })),
  };
};
